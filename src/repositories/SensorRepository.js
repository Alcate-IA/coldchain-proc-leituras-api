/**
 * Repository Pattern para acesso a dados de sensores
 * Abstrai a lógica de acesso ao banco de dados
 */

import { createClient } from '@supabase/supabase-js';
import { formatarMac } from '../utils/formatters.js';
import logger from '../utils/logger.js';

export class SensorRepository {
    constructor() {
        // Lazy initialization: cliente Supabase será criado apenas quando necessário
        this._supabase = null;
    }

    /**
     * Getter para o cliente Supabase com lazy initialization
     * Garante que as variáveis de ambiente estejam carregadas antes de criar o cliente
     */
    get supabase() {
        if (!this._supabase) {
            // Validação das variáveis de ambiente obrigatórias
            const supabaseUrl = process.env.SUPABASE_URL;
            const supabaseKey = process.env.SUPABASE_KEY;

            if (!supabaseUrl || !supabaseUrl.trim()) {
                throw new Error(
                    'SUPABASE_URL é obrigatória. ' +
                    'Configure a variável de ambiente SUPABASE_URL no arquivo .env. ' +
                    'Veja o arquivo .env.example para referência.'
                );
            }

            if (!supabaseKey || !supabaseKey.trim()) {
                throw new Error(
                    'SUPABASE_KEY é obrigatória. ' +
                    'Configure a variável de ambiente SUPABASE_KEY no arquivo .env. ' +
                    'Veja o arquivo .env.example para referência.'
                );
            }

            this._supabase = createClient(supabaseUrl.trim(), supabaseKey.trim());
        }
        return this._supabase;
    }

    /**
     * Busca todas as configurações de sensores
     */
    async findAllConfigs() {
        try {
            const { data, error } = await this.supabase
                .from('sensor_configs')
                .select('mac, sensor_porta_vinculado, display_name, temp_max, temp_min, hum_max, hum_min, em_manutencao');

            if (error) throw error;
            return data || [];
        } catch (e) {
            logger.logError('REPOSITORY', 'Erro ao buscar configurações de sensores', {
                error: e.message,
                stack: e.stack
            });
            throw e;
        }
    }

    /**
     * Busca último estado de portas
     */
    async findLastDoorStates(hours = 24) {
        try {
            const since = new Date(Date.now() - hours * 60 * 60 * 1000).toISOString();
            const { data, error } = await this.supabase
                .from('door_logs')
                .select('sensor_mac, is_open, timestamp_read')
                .gte('timestamp_read', since)
                .order('timestamp_read', { ascending: false });

            if (error) throw error;
            return data || [];
        } catch (e) {
            logger.logError('REPOSITORY', 'Erro ao buscar estados de porta', {
                error: e.message,
                stack: e.stack
            });
            throw e;
        }
    }

    /**
     * Insere logs de telemetria em lote
     */
    async insertTelemetryBatch(telemetryData) {
        try {
            const { error } = await this.supabase
                .from('telemetry_logs')
                .insert(telemetryData);

            if (error) throw error;
            return true;
        } catch (e) {
            logger.logError('REPOSITORY', 'Erro ao inserir telemetria', {
                error: e.message,
                batch_size: telemetryData.length
            });
            throw e;
        }
    }

    /**
     * Insere logs de porta em lote
     */
    async insertDoorBatch(doorData) {
        try {
            const { error } = await this.supabase
                .from('door_logs')
                .insert(doorData);

            if (error) throw error;
            return true;
        } catch (e) {
            logger.logError('REPOSITORY', 'Erro ao inserir logs de porta', {
                error: e.message,
                batch_size: doorData.length
            });
            throw e;
        }
    }

    /**
     * Busca gateways conhecidos das últimas 24h
     */
    async findKnownGateways(hours = 24) {
        try {
            const since = new Date(Date.now() - hours * 60 * 60 * 1000).toISOString();
            const { data, error } = await this.supabase
                .from('telemetry_logs')
                .select('gw, ts')
                .gte('ts', since)
                .order('ts', { ascending: false })
                .limit(2000);

            if (error) throw error;
            return data || [];
        } catch (e) {
            logger.logError('REPOSITORY', 'Erro ao buscar gateways conhecidos', {
                error: e.message
            });
            throw e;
        }
    }
}

export default new SensorRepository();
