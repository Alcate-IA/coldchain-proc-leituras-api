/**
 * Estratégia de detecção de ciclo de degelo
 * Implementa algoritmo melhorado com análise de fases e múltiplos critérios
 */

import { DetectionStrategy } from './DetectionStrategy.js';
import { DEFROST_DETECTION } from '../config/constants.js';

export class DefrostDetectionStrategy extends DetectionStrategy {
    constructor() {
        super();
        this.defrostHistory = new Map(); // Histórico de ciclos de degelo
    }

    /**
     * Detecta início ou fim de ciclo de degelo
     */
    detect(stats, tuning, state) {
        if (!stats.ready) {
            return { detected: false, reason: 'Dados insuficientes' };
        }

        const mac = state.mac;
        const now = Date.now();
        const isDefrosting = state.alertControl.is_defrosting;
        const tempAtual = state.lastReading.db_temp;

        // Detecção de início
        if (!isDefrosting) {
            return this._detectDefrostStart(stats, tuning, state, tempAtual, now);
        }

        // Detecção de fim
        return this._detectDefrostEnd(stats, tuning, state, tempAtual, now);
    }

    /**
     * Detecta início de ciclo de degelo
     */
    _detectDefrostStart(stats, tuning, state, tempAtual, now) {
        const isUltra = (state.config.temp_min && state.config.temp_min < -15);
        const minSlope = isUltra ? DEFROST_DETECTION.ULTRA_MIN_RISING_SLOPE : DEFROST_DETECTION.MIN_RISING_SLOPE;

        // Critério 1: Subida linear estável (método original melhorado)
        const criteria1 = stats.slope > minSlope &&
                         stats.stdError < tuning.DEFROST_VARIANCE_THRESHOLD &&
                         stats.r2 > tuning.DEFROST_MIN_R2 &&
                         stats.variance < tuning.DEFROST_VARIANCE_THRESHOLD;

        // Critério 2: Padrão de ciclo de degelo detectado (mais confiável)
        const criteria2 = stats.cicloDegelo && 
                         stats.cicloDegelo.isDefrostPattern &&
                         stats.cicloDegelo.phase === 'RISING' &&
                         stats.cicloDegelo.risingSlope > minSlope;

        // Critério 3: Para ultracongeladores, aceita slope mais alto com R² bom
        const criteria3 = isUltra &&
                         stats.slope > 0.3 &&
                         stats.r2 > 0.88 &&
                         stats.stdError < 0.6;

        // Critério 4: Análise de segmentos mostra mudança significativa
        const criteria4 = stats.segmentAnalysis &&
                         stats.segmentAnalysis.slopeChange > 0.5 &&
                         stats.slope > minSlope &&
                         stats.r2 > 0.75;

        if (criteria1 || criteria2 || criteria3 || criteria4) {
            const criteriaUsed = criteria1 ? 'CRIT1' : 
                                criteria2 ? 'CRIT2' : 
                                criteria3 ? 'CRIT3' : 'CRIT4';

            // Calcula confiança baseada em critérios atendidos
            const criteriaCount = [criteria1, criteria2, criteria3, criteria4].filter(v => v).length;
            const confidence = criteriaCount >= 2 ? 'HIGH' : 'MEDIUM';

            return {
                detected: true,
                action: 'START',
                reason: `Início de degelo detectado: ${criteriaUsed}`,
                criteria: criteriaUsed,
                confidence,
                metrics: {
                    slope: stats.slope,
                    r2: stats.r2,
                    variance: stats.variance,
                    stdError: stats.stdError,
                    phase: stats.cicloDegelo?.phase || 'N/A'
                }
            };
        }

        return { detected: false };
    }

    /**
     * Detecta fim de ciclo de degelo
     */
    _detectDefrostEnd(stats, tuning, state, tempAtual, now) {
        const defrostStart = state.alertControl.defrost_start_ts || 0;
        const defrostDuration = now - defrostStart;
        const isUltra = (state.config.temp_min && state.config.temp_min < -15);

        // Proteção: não permite fim imediatamente após início
        if (state.alertControl.defrost_just_started) {
            return { 
                detected: false, 
                reason: 'Degelo recém-iniciado - aguardando confirmação' 
            };
        }

        // Proteção: mínimo de duração antes de permitir fim
        if (defrostDuration < DEFROST_DETECTION.MIN_DURATION_BEFORE_END_MS) {
            return { 
                detected: false, 
                reason: `Degelo muito recente (${Math.floor(defrostDuration / 1000)}s)` 
            };
        }

        // Atualiza temperatura de pico
        if (tempAtual > (state.alertControl.defrost_peak_temp || tempAtual)) {
            state.alertControl.defrost_peak_temp = tempAtual;
        }

        const minFallingSlope = isUltra ? 
            DEFROST_DETECTION.ULTRA_MIN_FALLING_SLOPE : 
            DEFROST_DETECTION.MIN_FALLING_SLOPE;

        // Critério 1: Descida forte e consistente
        const criteria1 = stats.slope < -0.3 && stats.r2 > 0.7;

        // Critério 2: Fase de descida do ciclo detectada
        const criteria2 = stats.cicloDegelo &&
                         stats.cicloDegelo.phase === 'FALLING' &&
                         !(stats.cicloDegelo.phase === 'RISING') &&
                         stats.cicloDegelo.fallingSlope < minFallingSlope;

        // Critério 3: Degelo muito longo (timeout de segurança)
        const criteria3 = defrostDuration > 60 * 60 * 1000; // 60 minutos

        // Critério 4: Temperatura voltou próxima do início do degelo
        const tempRise = (state.alertControl.defrost_peak_temp || tempAtual) - 
                        (state.alertControl.defrost_start_temp || tempAtual);
        const tempRecovered = tempAtual <= (state.alertControl.defrost_start_temp || tempAtual) + 
                             (isUltra ? 3.0 : 2.0);
        const criteria4 = tempRecovered &&
                         defrostDuration > DEFROST_DETECTION.MIN_DURATION_BEFORE_END_MS &&
                         stats.slope < -0.1 &&
                         !(stats.cicloDegelo?.phase === 'RISING');

        // Critério 5: Análise de segmentos mostra descida consistente
        const criteria5 = stats.segmentAnalysis &&
                         stats.segmentAnalysis.slopeChange < -0.3 &&
                         stats.slope < minFallingSlope &&
                         stats.r2 > 0.6;

        if (criteria1 || criteria2 || criteria3 || criteria4 || criteria5) {
            const criteriaUsed = criteria1 ? 'CRIT1' : 
                                criteria2 ? 'CRIT2' : 
                                criteria3 ? 'CRIT3' : 
                                criteria4 ? 'CRIT4' : 'CRIT5';

            const durationMin = Math.floor(defrostDuration / 60000);
            const tempRiseFinal = (state.alertControl.defrost_peak_temp || tempAtual) - 
                                (state.alertControl.defrost_start_temp || tempAtual);

            return {
                detected: true,
                action: 'END',
                reason: `Fim de degelo detectado: ${criteriaUsed}`,
                criteria: criteriaUsed,
                confidence: 'HIGH',
                metrics: {
                    duration_min: durationMin,
                    temp_rise: tempRiseFinal,
                    temp_start: state.alertControl.defrost_start_temp,
                    temp_peak: state.alertControl.defrost_peak_temp,
                    temp_end: tempAtual,
                    slope: stats.slope,
                    fallingSlope: stats.cicloDegelo?.fallingSlope || null
                }
            };
        }

        return { detected: false };
    }

    /**
     * Analisa fase atual do ciclo de degelo
     */
    analyzePhase(stats, state) {
        if (!stats.cicloDegelo) {
            return { phase: 'UNKNOWN', confidence: 'LOW' };
        }

        const phase = stats.cicloDegelo.phase;
        const confidence = stats.cicloDegelo.isDefrostPattern ? 'HIGH' : 'MEDIUM';

        return {
            phase,
            confidence,
            risingSlope: stats.cicloDegelo.risingSlope,
            fallingSlope: stats.cicloDegelo.fallingSlope,
            tempRise: stats.cicloDegelo.tempRise,
            maxTemp: stats.cicloDegelo.maxTemp,
            minTemp: stats.cicloDegelo.minTemp
        };
    }
}
