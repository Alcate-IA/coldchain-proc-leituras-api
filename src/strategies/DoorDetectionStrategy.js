/**
 * Estratégia de detecção de porta aberta/fechada
 * Implementa algoritmo melhorado com múltiplos critérios e confirmação temporal
 */

import { DetectionStrategy } from './DetectionStrategy.js';
import { DOOR_DETECTION } from '../config/constants.js';

export class DoorDetectionStrategy extends DetectionStrategy {
    constructor() {
        super();
        this.doorStateHistory = new Map(); // Histórico de estados para confirmação
    }

    /**
     * Detecta abertura/fechamento de porta
     */
    detect(stats, tuning, state) {
        if (!stats.ready) {
            return { detected: false, reason: 'Dados insuficientes' };
        }

        const mac = state.mac;
        const now = Date.now();
        const currentState = state.alertControl.last_virtual_state;
        const tempAtual = state.lastReading.db_temp;
        
        // Durante degelo, não detecta porta
        if (state.alertControl.is_defrosting) {
            return { 
                detected: false, 
                newState: false, 
                reason: 'Degelo ativo' 
            };
        }

        // Validação de range normal: se temperatura está estável dentro do range, porta está fechada
        const tempDentroRange = this._isTempInRange(tempAtual, state.config, tuning);
        const tempEstavel = this._isTempStable(stats, tuning);

        if (tempDentroRange && tempEstavel) {
            if (currentState) {
                // Porta estava aberta mas agora está estável - fecha
                return {
                    detected: true,
                    newState: false,
                    reason: 'Temperatura estável dentro do range',
                    confidence: 'HIGH'
                };
            }
            return { 
                detected: false, 
                newState: false, 
                reason: 'Porta fechada - temperatura estável' 
            };
        }

        // Detecção de abertura
        if (!currentState) {
            const openDetection = this._detectDoorOpen(stats, tuning, tempAtual);
            if (openDetection.detected) {
                // Confirmação temporal: aguarda confirmação antes de mudar estado
                const confirmed = this._confirmStateChange(mac, true, now, openDetection);
                if (confirmed) {
                    return {
                        detected: true,
                        newState: true,
                        reason: openDetection.reason,
                        criteria: openDetection.criteria,
                        confidence: openDetection.confidence
                    };
                }
            }
        }

        // Detecção de fechamento
        if (currentState) {
            const closeDetection = this._detectDoorClose(stats, tuning, tempAtual, state);
            if (closeDetection.detected) {
                // Confirmação temporal: aguarda confirmação antes de mudar estado
                const confirmed = this._confirmStateChange(mac, false, now, closeDetection);
                if (confirmed) {
                    return {
                        detected: true,
                        newState: false,
                        reason: closeDetection.reason,
                        criteria: closeDetection.criteria,
                        confidence: closeDetection.confidence
                    };
                }
            }
        }

        return { detected: false, newState: currentState };
    }

    /**
     * Verifica se temperatura está dentro do range configurado
     */
    _isTempInRange(temp, config, tuning) {
        const LIMIT_TEMP_MAX = config.temp_max !== null ? config.temp_max : -5.0;
        const LIMIT_TEMP_MIN = config.temp_min !== null ? config.temp_min : -30.0;
        return temp >= LIMIT_TEMP_MIN && temp <= LIMIT_TEMP_MAX;
    }

    /**
     * Verifica se temperatura está estável
     */
    _isTempStable(stats, tuning) {
        return Math.abs(stats.slope) < 0.1 && 
               stats.variance < (tuning.DOOR_VARIANCE_THRESHOLD * 0.5) && 
               stats.r2 > 0.7;
    }

    /**
     * Detecta abertura de porta com múltiplos critérios
     */
    _detectDoorOpen(stats, tuning, tempAtual) {
        const criteria = {
            accel: stats.acceleration > tuning.DOOR_ACCEL,
            slope: stats.slope > tuning.DOOR_SLOPE,
            variance: stats.variance > tuning.DOOR_VARIANCE_THRESHOLD && 
                     stats.slope > 0.5 && 
                     stats.r2 < tuning.DOOR_R2_THRESHOLD,
            changePoint: stats.changePoint && 
                        stats.segmentAnalysis &&
                        Math.abs(stats.segmentAnalysis.slopeChange) > 1.0 &&
                        stats.variance > tuning.DOOR_VARIANCE_THRESHOLD,
            jerk: Math.abs(stats.jerk) > tuning.DOOR_JERK_THRESHOLD && 
                  stats.slope > 0.3
        };

        const detected = criteria.accel || criteria.slope || criteria.variance || 
                        criteria.changePoint || criteria.jerk;

        if (detected) {
            const criteriaUsed = Object.entries(criteria)
                .filter(([_, value]) => value)
                .map(([key, _]) => key.toUpperCase())
                .join('+');

            // Calcula confiança baseada em quantos critérios foram atendidos
            const criteriaCount = Object.values(criteria).filter(v => v).length;
            const confidence = criteriaCount >= 3 ? 'HIGH' : 
                             criteriaCount >= 2 ? 'MEDIUM' : 'LOW';

            return {
                detected: true,
                reason: `Abertura detectada: ${criteriaUsed}`,
                criteria: criteriaUsed,
                confidence
            };
        }

        return { detected: false };
    }

    /**
     * Detecta fechamento de porta
     */
    _detectDoorClose(stats, tuning, tempAtual, state) {
        const criteria = {
            slope: stats.slope < tuning.DOOR_CLOSE_SLOPE_THRESHOLD && stats.r2 > 0.5,
            accel: stats.slope < 0.1 && stats.acceleration < -0.1,
            variance: this._checkVarianceReduction(stats, state, tuning)
        };

        const detected = criteria.slope || criteria.accel || criteria.variance;

        if (detected) {
            const criteriaUsed = Object.entries(criteria)
                .filter(([_, value]) => value)
                .map(([key, _]) => key.toUpperCase())
                .join('+');

            return {
                detected: true,
                reason: `Fechamento detectado: ${criteriaUsed}`,
                criteria: criteriaUsed,
                confidence: 'MEDIUM'
            };
        }

        return { detected: false };
    }

    /**
     * Verifica redução de variância (indicador de fechamento)
     */
    _checkVarianceReduction(stats, state, tuning) {
        const prevVariance = state.alertControl.last_variance || stats.variance;
        const reduction = stats.variance < prevVariance * tuning.DOOR_CLOSE_VARIANCE_REDUCTION;
        const belowThreshold = stats.variance < tuning.DOOR_VARIANCE_THRESHOLD * 0.8;
        return reduction && belowThreshold;
    }

    /**
     * Confirma mudança de estado com histórico temporal
     * Evita falsos positivos aguardando confirmação
     */
    _confirmStateChange(mac, newState, now, detection) {
        if (!this.doorStateHistory.has(mac)) {
            this.doorStateHistory.set(mac, []);
        }

        const history = this.doorStateHistory.get(mac);
        
        // Adiciona detecção ao histórico
        history.push({
            state: newState,
            timestamp: now,
            confidence: detection.confidence,
            criteria: detection.criteria
        });

        // Mantém apenas últimas 10 detecções
        if (history.length > 10) {
            history.shift();
        }

        // Verifica se há confirmação suficiente
        const recentDetections = history.filter(h => 
            h.state === newState && 
            (now - h.timestamp) < (newState ? DOOR_DETECTION.MIN_OPEN_DURATION_MS : DOOR_DETECTION.MIN_CLOSE_DURATION_MS)
        );

        // Requer pelo menos 2 detecções recentes com mesma confiança
        const minConfirmations = detection.confidence === 'HIGH' ? 1 : 2;
        return recentDetections.length >= minConfirmations;
    }

    /**
     * Limpa histórico antigo
     */
    cleanHistory(maxAge) {
        const now = Date.now();
        for (const [mac, history] of this.doorStateHistory.entries()) {
            const filtered = history.filter(h => (now - h.timestamp) < maxAge);
            if (filtered.length === 0) {
                this.doorStateHistory.delete(mac);
            } else {
                this.doorStateHistory.set(mac, filtered);
            }
        }
    }
}
