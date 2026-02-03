/**
 * Modelo de estado do sensor
 * Representa o estado atual e histórico de um sensor
 */

export class SensorState {
    constructor(mac, config) {
        this.mac = mac;
        this.config = config;
        this.lastReading = {
            ts: 0,
            db_temp: -999,
            db_hum: -999,
            db_ts: 0
        };
        this.alertControl = {
            last_virtual_state: false,
            is_defrosting: false,
            last_variance: null,
            last_analysis_ts: null,
            defrost_start_ts: null,
            defrost_start_temp: null,
            defrost_peak_temp: null,
            defrost_end_ts: null,
            defrost_just_started: false,
            last_alert_sent_ts: null,
            last_porta_state_loaded_ts: null,
            last_porta_state_logged: false
        };
        this.history = [];
    }

    /**
     * Atualiza última leitura
     */
    updateReading(temp, hum, ts) {
        this.lastReading.ts = ts;
        this.lastReading.db_temp = temp;
        this.lastReading.db_hum = hum;
    }

    /**
     * Adiciona ponto ao histórico
     */
    addHistoryPoint(temp, ts) {
        this.history.push({ ts, temp });
    }

    /**
     * Limpa histórico antigo
     */
    cleanHistory(windowStart) {
        const before = this.history.length;
        this.history = this.history.filter(h => h.ts > windowStart);
        return before - this.history.length;
    }

    /**
     * Verifica se está em degelo
     */
    isDefrosting() {
        return this.alertControl.is_defrosting;
    }

    /**
     * Verifica se porta está aberta
     */
    isDoorOpen() {
        return this.alertControl.last_virtual_state;
    }

    /**
     * Obtém duração do degelo em minutos
     */
    getDefrostDuration(now) {
        if (!this.alertControl.defrost_start_ts) return 0;
        return Math.floor((now - this.alertControl.defrost_start_ts) / 60000);
    }
}
