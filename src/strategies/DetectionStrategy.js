/**
 * Strategy Pattern para detecção de eventos
 * Define interface comum para diferentes estratégias de detecção
 */

export class DetectionStrategy {
    /**
     * Detecta evento baseado em estatísticas
     * @param {Object} stats - Estatísticas calculadas
     * @param {Object} tuning - Parâmetros de tuning
     * @param {Object} state - Estado atual do sensor
     * @returns {Object|null} Resultado da detecção ou null
     */
    detect(stats, tuning, state) {
        throw new Error('Método detect deve ser implementado');
    }
}
