/**
 * Configurações e constantes globais do sistema
 * Centraliza todas as constantes para fácil manutenção
 */

export const TIMEZONE_CONFIG = 'America/Sao_Paulo';

// Blocklist de sensores/gateways
export const HARDCODED_BLOCKLIST = [
    'BC:57:29:1E:2F:2C', 
];

// Limites Globais (Fallback)
export const ENV_TEMP_MAX_NORMAL = Number(process.env.GLOBAL_TEMP_MAX) || -5.0; 
export const ENV_TEMP_MIN_GLOBAL = Number(process.env.GLOBAL_TEMP_MIN) || -30.0;
export const ENV_TEMP_MAX_HIGH_TRAFFIC = -2.0; 
export const DAYS_HIGH_TRAFFIC = [3, 4]; 

// Configurações de Banco e Rede
export const DB_FLUSH_INTERVAL_MS = 10000; 
export const DB_MIN_VAR_TEMP = 0.2;        
export const DB_MIN_VAR_HUM = 2.0;         
export const DB_HEARTBEAT_MS = 10 * 60 * 1000; 

// --- IA & INTEGRIDADE DE DADOS ---
export const PREDICT_WINDOW_MINS = 20;      // Janela de análise deslizante
export const MIN_DATA_POINTS = 10;          // Mínimo de pontos para regressão confiável
export const DATA_SAMPLE_INTERVAL_SEC = 10; // Intervalo mínimo entre amostras
export const DEFROST_CYCLE_MIN_DURATION_MS = 5 * 60 * 1000; // Degelo mínimo de 5min
export const DEFROST_CYCLE_MAX_DURATION_MS = 60 * 60 * 1000; // Degelo máximo de 60min

// *** TUNING FÍSICO: REFRIGERAÇÃO NORMAL (0°C a -10°C) ***
export const TUNING_NORMAL = {
    DOOR_ACCEL: 0.3,       // Aceleração súbita (Porta)
    DOOR_SLOPE: 0.9,       // Velocidade de subida bruta
    STD_ERROR_DOOR: 0.45,  // Turbulência alta (Ar externo misturando)
    DEFROST_MAX_SLOPE: 0.8,
    DEFROST_MIN_R2: 0.85,  // Degelo é linear, R² alto
    DEFROST_MIN_SLOPE: 0.15, // Slope mínimo para iniciar degelo
    DEFROST_VARIANCE_THRESHOLD: 0.5, // Variância máxima durante degelo
    DOOR_VARIANCE_THRESHOLD: 1.2,    // Variância alta indica porta
    EMA_ALPHA: 0.3,        // Filtro de média móvel exponencial
    // Novos parâmetros para melhor detecção
    DOOR_JERK_THRESHOLD: 0.5,        // Jerk alto indica mudança abrupta
    DOOR_R2_THRESHOLD: 0.6,          // R² baixo indica turbulência
    DOOR_STABILITY_TIME_MS: 3 * 60 * 1000, // Tempo para considerar estável
    DOOR_CLOSE_SLOPE_THRESHOLD: -0.1, // Slope negativo para fechamento
    DOOR_CLOSE_VARIANCE_REDUCTION: 0.7 // Redução de variância para fechamento
};

// *** TUNING FÍSICO: ULTRACONGELADORES (< -15°C) ***
export const TUNING_ULTRA = {
    DOOR_ACCEL: 0.6,       // Ar denso troca mais rápido
    DOOR_SLOPE: 1.5,       // Subida violenta
    STD_ERROR_DOOR: 0.65,  // Muita turbulência térmica
    DEFROST_MAX_SLOPE: 4.0,// Resistência aquece rápido
    DEFROST_MIN_R2: 0.90,  // Degelo controlado é muito estável
    DEFROST_MIN_SLOPE: 0.25, // Slope mínimo mais alto para ultracongeladores
    DEFROST_VARIANCE_THRESHOLD: 0.8, // Variância maior permitida
    DOOR_VARIANCE_THRESHOLD: 1.5,    // Variância ainda maior para porta
    EMA_ALPHA: 0.25,       // Filtro mais suave para ultracongeladores
    // Novos parâmetros para melhor detecção
    DOOR_JERK_THRESHOLD: 0.6,        // Jerk mais alto para ultracongeladores
    DOOR_R2_THRESHOLD: 0.55,         // R² um pouco mais baixo aceitável
    DOOR_STABILITY_TIME_MS: 4 * 60 * 1000, // Mais tempo para estabilizar
    DOOR_CLOSE_SLOPE_THRESHOLD: -0.15, // Slope mais negativo para fechamento
    DOOR_CLOSE_VARIANCE_REDUCTION: 0.75 // Redução maior de variância
};

// Alerting & Infra
export const BATCH_ALERT_INTERVAL_MS = 5 * 60 * 1000; 
export const ALERT_SOAK_TIME_MS = 10 * 60 * 1000;      
export const CALL_PERSISTENCE_MS = 30 * 60 * 1000;     
export const EXTREME_DEVIATION_C = 10.0;               
export const GATEWAY_TIMEOUT_MS = 15 * 60 * 1000; 
export const GATEWAY_CHECK_INTERVAL_MS = 60 * 1000;

// Melhorias no ciclo de degelo
export const DEFROST_DETECTION = {
    MIN_RISING_SLOPE: 0.15,           // Slope mínimo para detectar subida
    MIN_FALLING_SLOPE: -0.15,         // Slope mínimo para detectar descida
    MIN_TEMP_RISE: 2.0,               // Aumento mínimo de temperatura (°C)
    MIN_DURATION_BEFORE_END_MS: 2 * 60 * 1000, // Mínimo antes de permitir fim
    PEAK_DETECTION_WINDOW: 5,         // Janela de pontos para detectar pico
    PHASE_TRANSITION_THRESHOLD: 0.3,  // Threshold para transição de fase
    ULTRA_MIN_RISING_SLOPE: 0.25,     // Slope mínimo para ultracongeladores
    ULTRA_MIN_FALLING_SLOPE: -0.2      // Slope mínimo de descida para ultracongeladores
};

// Melhorias na detecção de portas
export const DOOR_DETECTION = {
    MIN_OPEN_DURATION_MS: 30 * 1000,  // Mínimo 30s para confirmar abertura
    MIN_CLOSE_DURATION_MS: 60 * 1000, // Mínimo 60s para confirmar fechamento
    STABILITY_CHECK_POINTS: 3,        // Pontos necessários para estabilidade
    TEMP_RISE_CONFIRMATION: 1.0,      // Aumento mínimo para confirmar abertura
    TEMP_DROP_CONFIRMATION: 0.5        // Queda mínima para confirmar fechamento
};
