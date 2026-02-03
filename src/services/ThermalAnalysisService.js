/**
 * Serviço de análise térmica
 * Implementa análise estatística avançada para detecção de padrões
 */

import * as ss from 'simple-statistics';
import { PREDICT_WINDOW_MINS, MIN_DATA_POINTS, DATA_SAMPLE_INTERVAL_SEC, TUNING_ULTRA, TUNING_NORMAL } from '../config/constants.js';
import logger from '../utils/logger.js';

export class ThermalAnalysisService {
    /**
     * Analisa tendência térmica do sensor
     */
    analisarTendencia(mac, tempAtual, isUltra = false, history) {
        const now = Date.now();
        const TUNING = isUltra ? TUNING_ULTRA : TUNING_NORMAL;

        // Controle de amostragem
        const lastSample = history.length > 0 ? history[history.length - 1] : null;
        const timeSinceLastSample = lastSample ? (now - lastSample.ts) : Infinity;

        // Adiciona novo ponto se passou tempo suficiente
        if (history.length === 0 || (timeSinceLastSample >= DATA_SAMPLE_INTERVAL_SEC * 1000)) {
            history.push({ ts: now, temp: tempAtual });
            
            // Janela deslizante de tempo
            const windowStart = now - (PREDICT_WINDOW_MINS * 60 * 1000);
            const beforeFilter = history.length;
            const filtered = history.filter(h => h.ts > windowStart);
            const removed = beforeFilter - filtered.length;
            
            if (removed > 0) {
                logger.logDebug('ANALISE', `Janela deslizante: ${removed} pontos antigos removidos`, { 
                    mac, 
                    pontos_atuais: filtered.length 
                });
            }
            
            history = filtered;
        } else {
            logger.logDebug('ANALISE', 'Amostra ignorada (muito recente)', { 
                mac, 
                intervalo_seg: Math.floor(timeSinceLastSample / 1000),
                temp: tempAtual 
            });
        }

        if (history.length < MIN_DATA_POINTS) {
            logger.logDebug('ANALISE', 'Dados insuficientes para análise', { 
                mac, 
                pontos: history.length, 
                minimo: MIN_DATA_POINTS,
                temp_atual: tempAtual 
            });
            return { ready: false, count: history.length };
        }

        // Normalizar tempo para minutos (X) e Temperatura (Y)
        const startTime = history[0].ts;
        const dataPoints = history.map(h => [(h.ts - startTime) / 60000, h.temp]);

        // 1. Regressão Linear Simples
        const line = ss.linearRegression(dataPoints);
        const regressionLine = ss.linearRegressionLine(line);

        // 2. R² (Coeficiente de Determinação)
        const r2 = ss.sampleCorrelation(dataPoints.map(p => p[0]), dataPoints.map(p => p[1])) ** 2;

        // 3. Erro Padrão da Estimativa
        const residuals = dataPoints.map(p => Math.pow(p[1] - regressionLine(p[0]), 2));
        const stdError = Math.sqrt(ss.mean(residuals));

        // 4. Variância e Desvio Padrão
        const temps = history.map(h => h.temp);
        const variance = ss.variance(temps);
        const stdDev = Math.sqrt(variance);

        // 5. Aceleração
        const acceleration = this._calculateAcceleration(history);

        // 6. Jerk (mudança na aceleração)
        const jerk = this._calculateJerk(history);

        // 7. Média Móvel Exponencial
        const ema = this._calculateEMA(history, TUNING.EMA_ALPHA);

        // 8. Análise de Ciclo de Degelo
        const cicloDegelo = this._analisarCicloDegelo(history, isUltra);

        // 9. Detecção de Mudança de Ponto
        const changePoint = this._detectarMudancaPonto(history);

        // 10. Análise de Segmentos
        let segmentAnalysis = null;
        if (changePoint && changePoint > 3 && changePoint < history.length - 3) {
            segmentAnalysis = this._analyzeSegments(history, changePoint);
        }

        const resultado = { 
            ready: true, 
            slope: line.m,
            acceleration,
            jerk,
            stdError,
            variance,
            stdDev,
            r2,
            avg: ss.mean(temps),
            ema,
            cicloDegelo,
            changePoint,
            segmentAnalysis,
            last_ts: history[history.length - 1].ts,
            history_length: history.length
        };

        logger.logDebug('ANALISE', 'Métricas calculadas', {
            mac,
            temp_atual: tempAtual,
            slope: line.m.toFixed(3),
            r2: r2.toFixed(3),
            variance: variance.toFixed(3),
            std_error: stdError.toFixed(3),
            acceleration: acceleration.toFixed(3),
            jerk: jerk.toFixed(3),
            ema: ema ? ema.toFixed(2) : null,
            pontos_historico: history.length,
            fase_ciclo: cicloDegelo?.phase || 'N/A',
            is_ultra: isUltra
        });

        return resultado;
    }

    /**
     * Calcula aceleração (mudança no slope)
     */
    _calculateAcceleration(history) {
        if (history.length < 6) return 0;

        const splitIndex = Math.floor(history.length * 0.7);
        const oldPart = history.slice(0, splitIndex);
        const newPart = history.slice(splitIndex);

        if (oldPart.length < 2 || newPart.length < 2) return 0;

        const slopeOld = ss.linearRegression(
            oldPart.map(h => [(h.ts - oldPart[0].ts) / 60000, h.temp])
        ).m;
        const slopeNew = ss.linearRegression(
            newPart.map(h => [(h.ts - newPart[0].ts) / 60000, h.temp])
        ).m;

        return slopeNew - slopeOld;
    }

    /**
     * Calcula jerk (mudança na aceleração)
     */
    _calculateJerk(history) {
        if (history.length < 9) return 0;

        const third1 = history.slice(0, Math.floor(history.length / 3));
        const third2 = history.slice(Math.floor(history.length / 3), Math.floor(history.length * 2 / 3));
        const third3 = history.slice(Math.floor(history.length * 2 / 3));

        if (third1.length < 2 || third2.length < 2 || third3.length < 2) return 0;

        const slope1 = ss.linearRegression(third1.map(h => [(h.ts - third1[0].ts) / 60000, h.temp])).m;
        const slope2 = ss.linearRegression(third2.map(h => [(h.ts - third2[0].ts) / 60000, h.temp])).m;
        const slope3 = ss.linearRegression(third3.map(h => [(h.ts - third3[0].ts) / 60000, h.temp])).m;

        const accel1 = slope2 - slope1;
        const accel2 = slope3 - slope2;

        return accel2 - accel1;
    }

    /**
     * Calcula média móvel exponencial
     */
    _calculateEMA(history, alpha) {
        if (history.length === 0) return null;
        let ema = history[0].temp;
        for (let i = 1; i < history.length; i++) {
            ema = alpha * history[i].temp + (1 - alpha) * ema;
        }
        return ema;
    }

    /**
     * Analisa ciclo de degelo completo
     */
    _analisarCicloDegelo(history, isUltra) {
        if (history.length < 8) return null;

        const temps = history.map(h => h.temp);
        const maxTemp = Math.max(...temps);
        const minTemp = Math.min(...temps);
        const maxIndex = temps.indexOf(maxTemp);
        const minIndex = temps.indexOf(minTemp);

        const isRisingPhase = maxIndex > minIndex && maxIndex > history.length * 0.3;
        const isFallingPhase = maxIndex < history.length - 3;

        let risingSlope = 0;
        let fallingSlope = 0;

        if (isRisingPhase && maxIndex > 2) {
            const risingData = history.slice(0, maxIndex + 1)
                .map(h => [(h.ts - history[0].ts) / 60000, h.temp]);
            if (risingData.length > 2) {
                risingSlope = ss.linearRegression(risingData).m;
            }
        }

        if (isFallingPhase && maxIndex < history.length - 2) {
            const fallingData = history.slice(maxIndex)
                .map(h => [(h.ts - history[maxIndex].ts) / 60000, h.temp]);
            if (fallingData.length > 2) {
                fallingSlope = ss.linearRegression(fallingData).m;
            }
        }

        const minRisingSlope = isUltra ? 0.2 : 0.15;
        const isDefrostPattern = risingSlope > minRisingSlope && fallingSlope < -0.1;
        const tempRise = maxTemp - minTemp;

        return {
            isDefrostPattern,
            risingSlope,
            fallingSlope,
            tempRise,
            maxTemp,
            minTemp,
            maxIndex,
            phase: isRisingPhase && !isFallingPhase ? 'RISING' : 
                   isFallingPhase && !isRisingPhase ? 'FALLING' : 
                   isRisingPhase && isFallingPhase ? 'PEAK' : 'UNKNOWN'
        };
    }

    /**
     * Detecta mudança de ponto
     */
    _detectarMudancaPonto(history) {
        if (history.length < 6) return null;

        let minVariance = Infinity;
        let bestSplit = null;

        for (let i = 3; i < history.length - 3; i++) {
            const part1 = history.slice(0, i).map(h => h.temp);
            const part2 = history.slice(i).map(h => h.temp);

            const var1 = ss.variance(part1);
            const var2 = ss.variance(part2);
            const totalVar = var1 + var2;

            if (totalVar < minVariance) {
                minVariance = totalVar;
                bestSplit = i;
            }
        }

        return bestSplit;
    }

    /**
     * Analisa segmentos após mudança de ponto
     */
    _analyzeSegments(history, changePoint) {
        const seg1 = history.slice(0, changePoint);
        const seg2 = history.slice(changePoint);

        const slope1 = ss.linearRegression(
            seg1.map(h => [(h.ts - seg1[0].ts) / 60000, h.temp])
        ).m;
        const slope2 = ss.linearRegression(
            seg2.map(h => [(h.ts - seg2[0].ts) / 60000, h.temp])
        ).m;

        return {
            changePoint,
            slope1,
            slope2,
            slopeChange: slope2 - slope1
        };
    }
}

export default new ThermalAnalysisService();
