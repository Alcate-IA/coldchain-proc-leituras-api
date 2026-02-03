/**
 * Utilitários de formatação
 * Funções auxiliares para formatação de dados
 */

/**
 * Formata MAC address para formato padrão (XX:XX:XX:XX:XX:XX)
 */
export const formatarMac = (mac) => {
    if (!mac) return null;
    return mac?.includes(':') ? mac : mac?.replace(/(.{2})(?=.)/g, '$1:');
};

/**
 * Calcula percentual de bateria baseado em milivolts
 */
export const calcularBateria = (mV) => {
    if (!mV) return 0;
    return Math.min(100, Math.max(0, Math.round(((mV - 2500) / (3600 - 2500)) * 100)));
};

/**
 * Formata tempo decorrido em formato legível
 */
export const formatarTempoDecorrido = (ms) => {
    if (ms < 1000) return `${ms}ms`;
    if (ms < 60000) return `${Math.floor(ms / 1000)}s`;
    if (ms < 3600000) return `${Math.floor(ms / 60000)}min`;
    return `${Math.floor(ms / 3600000)}h ${Math.floor((ms % 3600000) / 60000)}min`;
};
