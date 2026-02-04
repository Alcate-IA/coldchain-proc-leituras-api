/**
 * Serviço principal de gerenciamento de sensores
 * Orquestra detecções, alertas e persistência
 */

import { SensorState } from '../models/SensorState.js';
import { DoorDetectionStrategy } from '../strategies/DoorDetectionStrategy.js';
import { DefrostDetectionStrategy } from '../strategies/DefrostDetectionStrategy.js';
import thermalAnalysisService from './ThermalAnalysisService.js';
import { formatarMac, calcularBateria } from '../utils/formatters.js';
import { TUNING_NORMAL, TUNING_ULTRA, EXTREME_DEVIATION_C, ALERT_SOAK_TIME_MS, CALL_PERSISTENCE_MS, DOOR_DETECTION, TEMP_MIN_THRESHOLD, TEMP_MAX_THRESHOLD } from '../config/constants.js';
import moment from 'moment-timezone';
import { TIMEZONE_CONFIG } from '../config/constants.js';
import logger from '../utils/logger.js';

export class SensorService {
    constructor(alertWatchlist = null) {
        this.doorStrategy = new DoorDetectionStrategy();
        this.defrostStrategy = new DefrostDetectionStrategy();
        this.sensorStates = new Map();
        this.alertWatchlist = alertWatchlist; // Watchlist para controle de duplicatas
    }

    /**
     * Processa leitura de sensor
     */
    verificarSensor(sensorMac, leitura, gatewayMac, config) {
        const nome = config.display_name || sensorMac;
        const now = Date.now();

        // Ignora sensores em manutenção
        if (config.em_manutencao) {
            return null;
        }

        // Obtém ou cria estado do sensor
        let state = this.sensorStates.get(sensorMac);
        if (!state) {
            state = new SensorState(sensorMac, config);
            this.sensorStates.set(sensorMac, state);
        }

        // Atualiza leitura
        const val = Number(leitura.temp);
        state.updateReading(val, leitura.humidity, now);

        // Define perfil (NORMAL vs ULTRA)
        const isUltra = (config.temp_min && config.temp_min < -15);
        const TUNING = isUltra ? TUNING_ULTRA : TUNING_NORMAL;

        // Análise térmica
        const iaStats = thermalAnalysisService.analisarTendencia(
            sensorMac, 
            val, 
            isUltra, 
            state.history
        );

        // Atualiza histórico
        state.addHistoryPoint(val, now);
        const windowStart = now - (20 * 60 * 1000); // 20 minutos
        state.cleanHistory(windowStart);

        // Detecção de degelo
        const defrostResult = this._processDefrostDetection(iaStats, TUNING, state, isUltra, val, now, nome);

        // Detecção de porta
        const doorResult = this._processDoorDetection(iaStats, TUNING, state, val, now, nome, gatewayMac, leitura);

        // Processa alertas de temperatura/umidade
        const alerta = this._processAlerts(iaStats, state, config, val, leitura, isUltra, now, nome);

        // Processa alerta de porta aberta por muito tempo
        const alertaPorta = this._processDoorOpenAlert(state, now, nome);

        return {
            defrost: defrostResult,
            door: doorResult,
            alert: alerta || alertaPorta // Retorna qualquer um dos alertas
        };
    }

    /**
     * Processa detecção de degelo
     */
    _processDefrostDetection(iaStats, tuning, state, isUltra, tempAtual, now, nome) {
        if (!iaStats.ready) return null;

        const result = this.defrostStrategy.detect(iaStats, tuning, state);

        if (result.detected) {
            if (result.action === 'START') {
                state.alertControl.is_defrosting = true;
                state.alertControl.defrost_start_ts = now;
                state.alertControl.defrost_start_temp = tempAtual;
                state.alertControl.defrost_peak_temp = tempAtual;
                state.alertControl.defrost_just_started = true;

                logger.info(`❄️ [DEGELO INICIO] ${nome}`, {
                    criterio: result.criteria,
                    confidence: result.confidence,
                    ...result.metrics
                });
            } else if (result.action === 'END') {
                state.alertControl.is_defrosting = false;
                state.alertControl.defrost_end_ts = now;

                logger.info(`❄️ [DEGELO FIM] ${nome}`, {
                    criterio: result.criteria,
                    ...result.metrics
                });

                // Limpa dados do ciclo
                delete state.alertControl.defrost_start_ts;
                delete state.alertControl.defrost_start_temp;
                delete state.alertControl.defrost_peak_temp;
            }
        } else if (state.alertControl.defrost_just_started) {
            // Remove flag após primeiro ciclo
            state.alertControl.defrost_just_started = false;
        }

        return result;
    }

    /**
     * Processa detecção de porta
     */
    _processDoorDetection(iaStats, tuning, state, tempAtual, now, nome, gatewayMac, leitura) {
        if (!iaStats.ready || state.alertControl.is_defrosting) {
            return null;
        }

        const result = this.doorStrategy.detect(iaStats, tuning, state);

        if (result.detected && result.newState !== state.alertControl.last_virtual_state) {
            const acao = result.newState ? 'ABRIU 🔓' : 'FECHOU 🔒';
            logger.info(`🔄 [ESTADO] ${nome}: ${acao}`, {
                reason: result.reason,
                criteria: result.criteria,
                confidence: result.confidence,
                temp: tempAtual.toFixed(1)
            });

            state.alertControl.last_virtual_state = result.newState;
            state.alertControl.last_analysis_ts = now;

            return {
                is_open: result.newState,
                gateway_mac: gatewayMac || "GW-UNKNOWN",
                sensor_mac: state.mac,
                timestamp_read: new Date().toISOString(),
                alarm_code: result.newState ? 1 : 0,
                battery_percent: calcularBateria(leitura.vbatt),
                rssi: leitura.rssi
            };
        }

        return null;
    }

    /**
     * Processa alertas de temperatura/umidade
     * 
     * NOTA: Alertas preditivos e de degelo foram removidos conforme requisito.
     * Apenas alertas de temperatura/umidade fora dos limites são enviados.
     * Implementa watchlist e soak time para evitar alertas duplicados.
     */
    _processAlerts(iaStats, state, config, val, leitura, isUltra, now, nome) {
        // Durante degelo, não envia alertas (suprime todos os alertas durante degelo)
        if (state.alertControl.is_defrosting) {
            return null;
        }

        // Limites de temperatura
        const diaHoje = moment(now).tz(TIMEZONE_CONFIG).day();
        const isAltoFluxo = [3, 4].includes(diaHoje);
        const LIMIT_TEMP_MAX = config.temp_max !== null ? config.temp_max : (isAltoFluxo ? -2.0 : -5.0);
        const LIMIT_TEMP_MIN = config.temp_min !== null ? config.temp_min : -30.0;

        let mensagemProblema = null;
        let prioridade = 'ALTA';
        let desvioExtremo = false;
        let tipoAlerta = null; // Identificador do tipo de alerta para watchlist

        // Calcula limites com tolerância (threshold)
        // Para temperatura mínima: só alerta se estiver abaixo de (LIMIT_TEMP_MIN + THRESHOLD)
        // Exemplo: se min = -5°C e threshold = 3°C, só alerta se temp < -2°C
        const LIMIT_TEMP_MIN_ALERT = LIMIT_TEMP_MIN + TEMP_MIN_THRESHOLD;
        
        // Para temperatura máxima: só alerta se estiver acima de (LIMIT_TEMP_MAX - THRESHOLD)
        // Exemplo: se max = -5°C e threshold = 3°C, só alerta se temp > -8°C
        const LIMIT_TEMP_MAX_ALERT = LIMIT_TEMP_MAX - TEMP_MAX_THRESHOLD;

        // Apenas alerta se temperatura estiver fora dos limites com tolerância (não preditivo)
        if (val < LIMIT_TEMP_MIN_ALERT) {
            mensagemProblema = `Temp BAIXA: ${val}°C (Min: ${LIMIT_TEMP_MIN}°C, Threshold: ${TEMP_MIN_THRESHOLD}°C)`;
            tipoAlerta = 'TEMP_BAIXA';
            if (val < (LIMIT_TEMP_MIN - EXTREME_DEVIATION_C)) {
                desvioExtremo = true;
                prioridade = 'CRITICA';
            }
        } else if (val > LIMIT_TEMP_MAX_ALERT) {
            mensagemProblema = `Temp ALTA: ${val}°C (Max: ${LIMIT_TEMP_MAX}°C, Threshold: ${TEMP_MAX_THRESHOLD}°C)`;
            tipoAlerta = 'TEMP_ALTA';
            if (val > (LIMIT_TEMP_MAX + EXTREME_DEVIATION_C)) {
                desvioExtremo = true;
                prioridade = 'CRITICA';
            }
        }
        // Removido: lógica de alertas preditivos (PREDITIVA e CRITICA)

        // Validação de umidade
        if (!mensagemProblema && leitura.humidity !== undefined) {
            const valHum = Number(leitura.humidity);
            if (config.hum_max && valHum > config.hum_max) {
                mensagemProblema = `Umid ALTA: ${valHum}%`;
                tipoAlerta = 'UMID_ALTA';
            } else if (config.hum_min && valHum < config.hum_min) {
                mensagemProblema = `Umid BAIXA: ${valHum}%`;
                tipoAlerta = 'UMID_BAIXA';
            }
        }

        if (!mensagemProblema) return null;

        // Gestão de watchlist e soak time
        // Verifica se já existe alerta recente do mesmo tipo para este sensor
        if (this.alertWatchlist) {
            const watchlistKey = `${state.mac}_${tipoAlerta}`;
            const lastAlertTime = this.alertWatchlist.get(watchlistKey);
            
            if (lastAlertTime && (now - lastAlertTime) < ALERT_SOAK_TIME_MS) {
                const tempoRestante = Math.floor((ALERT_SOAK_TIME_MS - (now - lastAlertTime)) / 60000);
                logger.logDebug('ALERTA', `Alerta suprimido por soak time: ${nome} - ${tipoAlerta}`, {
                    sensor: state.mac,
                    tipo: tipoAlerta,
                    tempo_restante_min: tempoRestante,
                    ultimo_alerta: new Date(lastAlertTime).toISOString()
                });
                return null; // Suprime alerta duplicado
            }
            
            // Atualiza watchlist com timestamp do novo alerta
            this.alertWatchlist.set(watchlistKey, now);
            logger.logDebug('ALERTA', `Alerta adicionado à watchlist: ${nome} - ${tipoAlerta}`, {
                sensor: state.mac,
                tipo: tipoAlerta,
                watchlist_size: this.alertWatchlist.size
            });
        }

        return this._createAlert(
            nome,
            state.mac,
            mensagemProblema,
            prioridade,
            now,
            {
                temp_atual: val,
                limites: { max: LIMIT_TEMP_MAX, min: LIMIT_TEMP_MIN },
                status_operacional: state.alertControl.is_defrosting ? "EM_DEGELO" : "NORMAL",
                stats_ia: iaStats.ready ? {
                    slope: iaStats.slope,
                    r2: iaStats.r2,
                    variance: iaStats.variance
                } : { ready: false }
            }
        );
    }

    /**
     * Processa alerta de porta aberta por muito tempo
     */
    _processDoorOpenAlert(state, now, nome) {
        // Verifica se porta está aberta
        if (!state.alertControl.last_virtual_state) {
            return null;
        }

        // Verifica se está em degelo (não alerta durante degelo)
        if (state.alertControl.is_defrosting) {
            return null;
        }

        // Verifica há quanto tempo a porta está aberta
        const portaAbertaDesde = state.alertControl.last_analysis_ts || now;
        const tempoAberta = now - portaAbertaDesde;

        // Se porta está aberta há mais que o tempo máximo configurado
        if (tempoAberta > DOOR_DETECTION.MAX_OPEN_TIME_MS) {
            const minutosAberta = Math.floor(tempoAberta / 60000);

            // Verifica watchlist para evitar alertas duplicados
            if (this.alertWatchlist) {
                const watchlistKey = `${state.mac}_PORTA_ABERTA`;
                const lastAlertTime = this.alertWatchlist.get(watchlistKey);
                
                if (lastAlertTime && (now - lastAlertTime) < ALERT_SOAK_TIME_MS) {
                    const tempoRestante = Math.floor((ALERT_SOAK_TIME_MS - (now - lastAlertTime)) / 60000);
                    logger.logDebug('ALERTA', `Alerta de porta suprimido por soak time: ${nome}`, {
                        sensor: state.mac,
                        tempo_restante_min: tempoRestante,
                        minutos_aberta: minutosAberta
                    });
                    return null; // Suprime alerta duplicado
                }
                
                // Atualiza watchlist
                this.alertWatchlist.set(watchlistKey, now);
            }

            return this._createAlert(
                nome,
                state.mac,
                `🚪 PORTA ABERTA há ${minutosAberta} minutos`,
                'ALTA',
                now,
                {
                    tipo: 'PORTA_ABERTA',
                    minutos_aberta: minutosAberta,
                    porta_aberta_desde: new Date(portaAbertaDesde).toISOString(),
                    temp_atual: state.lastReading.db_temp,
                    status_operacional: 'PORTA_ABERTA'
                }
            );
        }

        return null;
    }

    /**
     * Cria objeto de alerta
     */
    _createAlert(nome, mac, mensagem, prioridade, now, dadosContexto) {
        return {
            sensor_nome: nome,
            sensor_mac: mac,
            prioridade,
            mensagens: [mensagem],
            timestamp_iso: moment(now).tz(TIMEZONE_CONFIG).format(),
            dados_contexto: dadosContexto
        };
    }

    /**
     * Obtém estado do sensor
     */
    getSensorState(mac) {
        return this.sensorStates.get(mac);
    }

    /**
     * Obtém todos os estados
     */
    getAllSensorStates() {
        return Array.from(this.sensorStates.values());
    }

    /**
     * Limpa estados antigos
     */
    cleanOldStates(maxAge) {
        const now = Date.now();
        for (const [mac, state] of this.sensorStates.entries()) {
            if (state.lastReading.ts > 0 && (now - state.lastReading.ts) > maxAge) {
                this.sensorStates.delete(mac);
            }
        }
    }

    /**
     * Cria ou obtém estado do sensor
     */
    getOrCreateSensorState(mac, config) {
        let state = this.sensorStates.get(mac);
        if (!state) {
            state = new SensorState(mac, config);
            this.sensorStates.set(mac, state);
        }
        return state;
    }
}

// Exporta a classe para permitir instanciação com watchlist
export default SensorService;
