/**
 * Serviço de health check
 * Coleta métricas detalhadas do sistema para o endpoint /health
 */

import { formatarTempoDecorrido } from '../utils/formatters.js';
import thermalAnalysisService from './ThermalAnalysisService.js';
import { MIN_DATA_POINTS } from '../config/constants.js';
import logger from '../utils/logger.js';

export class HealthService {
    constructor(sensorService, configCache, gatewayHeartbeats, buffers) {
        this.sensorService = sensorService;
        this.configCache = configCache;
        this.gatewayHeartbeats = gatewayHeartbeats;
        this.buffers = buffers;
    }

    /**
     * Gera relatório completo de saúde do sistema
     */
    generateHealthReport() {
        const now = Date.now();
        const sensorsDetail = [];
        const systemMetrics = this._calculateSystemMetrics(now);
        const performanceMetrics = this._calculatePerformanceMetrics(now);

        // Detalhes de cada sensor
        this.configCache.forEach((config, mac) => {
            const state = this.sensorService.getSensorState(mac);
            const sensorInfo = this._getSensorInfo(mac, config, state, now);
            sensorsDetail.push(sensorInfo);
        });

        sensorsDetail.sort((a, b) => a.nome.localeCompare(b.nome));

        return {
            status: 'UP',
            timestamp: new Date().toISOString(),
            uptime: {
                seconds: Math.floor(process.uptime()),
                formatted: formatarTempoDecorrido(process.uptime() * 1000)
            },
            system: {
                node_version: process.version,
                memory: {
                    used_mb: Math.round(process.memoryUsage().heapUsed / 1024 / 1024),
                    total_mb: Math.round(process.memoryUsage().heapTotal / 1024 / 1024),
                    rss_mb: Math.round(process.memoryUsage().rss / 1024 / 1024),
                    external_mb: Math.round(process.memoryUsage().external / 1024 / 1024)
                },
                cpu_usage: process.cpuUsage(),
                platform: process.platform
            },
            sensors: {
                total: this.configCache.size,
                with_data: systemMetrics.sensoresComDados,
                in_defrost: systemMetrics.sensoresEmDegelo,
                door_open: systemMetrics.sensoresPortaAberta,
                in_maintenance: systemMetrics.sensoresEmManutencao,
                ultracongeladores: systemMetrics.ultracongeladores,
                detail: sensorsDetail
            },
            gateways: {
                total: this.gatewayHeartbeats.size,
                active: systemMetrics.gatewaysAtivos,
                offline: systemMetrics.gatewaysOffline,
                last_seen: systemMetrics.gatewayLastSeen
            },
            buffers: {
                telemetry: {
                    size: this.buffers.telemetry.length,
                    oldest_entry: this.buffers.telemetry.length > 0 ? 
                        this._getOldestTimestamp(this.buffers.telemetry) : null
                },
                door: {
                    size: this.buffers.door.length,
                    oldest_entry: this.buffers.door.length > 0 ? 
                        this._getOldestTimestamp(this.buffers.door) : null
                },
                alerts: {
                    size: this.buffers.alerts.length,
                    oldest_entry: this.buffers.alerts.length > 0 ? 
                        this._getOldestTimestamp(this.buffers.alerts) : null
                }
            },
            performance: performanceMetrics,
            alerts: {
                watchlist_size: systemMetrics.watchlistSize,
                recent_alerts: systemMetrics.recentAlerts
            }
        };
    }

    /**
     * Obtém informações detalhadas de um sensor
     */
    _getSensorInfo(mac, config, state, now) {
        const hasData = state && state.lastReading && state.lastReading.ts > 0;
        const isUltra = (config.temp_min && config.temp_min < -15);
        
        let statusGeral = 'OK 🟢';
        if (state?.alertControl?.is_defrosting) {
            statusGeral = 'DEGELO ❄️';
        } else if (state?.alertControl?.last_virtual_state) {
            statusGeral = 'PORTA ABERTA 🔓';
        } else if (config.em_manutencao) {
            statusGeral = 'MANUTENÇÃO 🔧';
        }

        // Análise térmica
        let iaMetrics = null;
        let defrostInfo = null;
        let doorInfo = null;
        let thermalTrend = null;

        if (state && state.history && state.history.length >= MIN_DATA_POINTS) {
            const tempAtual = hasData ? state.lastReading.db_temp : null;
            if (tempAtual !== null) {
                const stats = thermalAnalysisService.analisarTendencia(
                    mac, 
                    tempAtual, 
                    isUltra, 
                    state.history
                );

                if (stats.ready) {
                    iaMetrics = {
                        slope: Number(stats.slope.toFixed(3)),
                        r2: Number(stats.r2.toFixed(3)),
                        variance: Number(stats.variance.toFixed(3)),
                        std_error: Number(stats.stdError.toFixed(3)),
                        acceleration: Number(stats.acceleration.toFixed(3)),
                        jerk: Number(stats.jerk.toFixed(3)),
                        ema: stats.ema ? Number(stats.ema.toFixed(2)) : null,
                        history_points: stats.history_length
                    };

                    thermalTrend = {
                        direction: stats.slope > 0.1 ? 'RISING' : 
                                  stats.slope < -0.1 ? 'FALLING' : 'STABLE',
                        confidence: stats.r2 > 0.8 ? 'HIGH' : 
                                   stats.r2 > 0.6 ? 'MEDIUM' : 'LOW',
                        projected_15min: stats.slope > 0 ? 
                            Number((tempAtual + stats.slope * 15).toFixed(1)) : null
                    };

                    if (stats.cicloDegelo) {
                        iaMetrics.defrost_phase = stats.cicloDegelo.phase;
                        iaMetrics.defrost_pattern = stats.cicloDegelo.isDefrostPattern;
                    }
                }
            }
        }

        // Informações de degelo
        if (state?.alertControl?.is_defrosting) {
            const defrostStart = state.alertControl.defrost_start_ts || 0;
            const duration = defrostStart > 0 ? Math.floor((now - defrostStart) / 60000) : 0;
            defrostInfo = {
                duracao_min: duration,
                temp_inicio: state.alertControl.defrost_start_temp || null,
                temp_pico: state.alertControl.defrost_peak_temp || null,
                temp_atual: hasData ? state.lastReading.db_temp : null
            };
        }

        // Informações de porta
        if (state?.alertControl) {
            doorInfo = {
                is_open: state.alertControl.last_virtual_state || false,
                last_state_change: state.alertControl.last_analysis_ts ? 
                    new Date(state.alertControl.last_analysis_ts).toISOString() : null,
                state_duration_min: state.alertControl.last_analysis_ts ? 
                    Math.floor((now - state.alertControl.last_analysis_ts) / 60000) : null
            };
        }

        return {
            nome: config.display_name || mac,
            mac: mac,
            temp: hasData ? Number(state.lastReading.db_temp.toFixed(1)) : null,
            humidity: hasData && state.lastReading.db_hum !== -999 ? 
                Number(state.lastReading.db_hum.toFixed(1)) : null,
            status: statusGeral,
            last_seen: hasData ? {
                timestamp: new Date(state.lastReading.ts).toISOString(),
                ago_seconds: Math.floor((now - state.lastReading.ts) / 1000),
                ago_formatted: formatarTempoDecorrido(now - state.lastReading.ts)
            } : null,
            ia_metrics: iaMetrics,
            thermal_trend: thermalTrend,
            defrost_info: defrostInfo,
            door_info: doorInfo,
            config: {
                temp_max: config.temp_max,
                temp_min: config.temp_min,
                hum_max: config.hum_max,
                hum_min: config.hum_min,
                is_ultra: isUltra,
                em_manutencao: config.em_manutencao || false
            }
        };
    }

    /**
     * Calcula métricas do sistema
     */
    _calculateSystemMetrics(now) {
        const allStates = this.sensorService.getAllSensorStates();
        const sensoresComDados = allStates.filter(s => s.lastReading.ts > 0).length;
        const sensoresEmDegelo = allStates.filter(s => s.alertControl.is_defrosting).length;
        const sensoresPortaAberta = allStates.filter(s => s.alertControl.last_virtual_state).length;
        const sensoresEmManutencao = Array.from(this.configCache.values())
            .filter(c => c.em_manutencao).length;
        const ultracongeladores = Array.from(this.configCache.values())
            .filter(c => c.temp_min && c.temp_min < -15).length;

        // Gateways
        const gatewayTimeout = 15 * 60 * 1000;
        let gatewaysAtivos = 0;
        let gatewaysOffline = 0;
        let gatewayLastSeen = null;

        for (const [gmac, data] of this.gatewayHeartbeats.entries()) {
            const timeSinceLastSeen = now - data.last_seen;
            if (timeSinceLastSeen < gatewayTimeout) {
                gatewaysAtivos++;
            } else {
                gatewaysOffline++;
            }
            if (!gatewayLastSeen || data.last_seen > gatewayLastSeen) {
                gatewayLastSeen = data.last_seen;
            }
        }

        return {
            sensoresComDados,
            sensoresEmDegelo,
            sensoresPortaAberta,
            sensoresEmManutencao,
            ultracongeladores,
            gatewaysAtivos,
            gatewaysOffline,
            gatewayLastSeen: gatewayLastSeen ? new Date(gatewayLastSeen).toISOString() : null,
            watchlistSize: 0, // Pode ser expandido
            recentAlerts: 0    // Pode ser expandido
        };
    }

    /**
     * Calcula métricas de performance
     */
    _calculatePerformanceMetrics(now) {
        return {
            event_loop_lag: process.hrtime()[1] / 1000000, // Aproximação
            active_handles: process._getActiveHandles ? process._getActiveHandles().length : 'N/A',
            active_requests: process._getActiveRequests ? process._getActiveRequests().length : 'N/A'
        };
    }

    /**
     * Obtém timestamp mais antigo de um buffer
     */
    _getOldestTimestamp(buffer) {
        if (!buffer || buffer.length === 0) return null;
        
        // Tenta encontrar timestamp em diferentes formatos
        const first = buffer[0];
        if (first.timestamp_read) return first.timestamp_read;
        if (first.timestamp_iso) return first.timestamp_iso;
        if (first.ts) return first.ts;
        return null;
    }
}
