/**
 * ColdChain Neural v5 - API de Monitoramento de Sensores
 * Arquitetura refatorada com Design Patterns e melhorias na detecção
 * 
 * Design Patterns implementados:
 * - Strategy: Detecção de porta e degelo
 * - Repository: Acesso a dados
 * - Service: Lógica de negócio
 * - Controller: Endpoints HTTP
 * - Singleton: Logger
 * - Factory: Criação de estados de sensores
 */

import dotenv from 'dotenv';
dotenv.config();

import express from 'express';
import cors from 'cors';
import mqtt from 'mqtt';
import moment from 'moment-timezone';

// Configurações e constantes
import { 
    TIMEZONE_CONFIG, 
    HARDCODED_BLOCKLIST,
    DB_FLUSH_INTERVAL_MS,
    DB_MIN_VAR_TEMP,
    DB_MIN_VAR_HUM,
    DB_HEARTBEAT_MS,
    BATCH_ALERT_INTERVAL_MS,
    ALERT_SOAK_TIME_MS,
    GATEWAY_TIMEOUT_MS,
    GATEWAY_CHECK_INTERVAL_MS
} from './src/config/constants.js';

// Utilitários
import logger from './src/utils/logger.js';
import { formatarMac, calcularBateria } from './src/utils/formatters.js';

// Repositories
import sensorRepository from './src/repositories/SensorRepository.js';

// Services
import SensorService from './src/services/SensorService.js';
import { HealthService } from './src/services/HealthService.js';

// Controllers
import { HealthController } from './src/controllers/HealthController.js';

// ============================================================================
// INICIALIZAÇÃO
// ============================================================================

const app = express();
app.use(express.json());
app.use(cors());

// Estado em memória
const configCache = new Map();
const secondarySensorsBlocklist = new Set();
const gatewayHeartbeats = new Map();
const alertWatchlist = new Map();

// Buffers para persistência
const dbTelemetryBuffer = [];
const dbDoorBuffer = [];
const n8nAlertBuffer = [];

// Sensor Service (instanciado com watchlist)
const sensorService = new SensorService(alertWatchlist);

// Health Service
const healthService = new HealthService(
    sensorService,
    configCache,
    gatewayHeartbeats,
    {
        telemetry: dbTelemetryBuffer,
        door: dbDoorBuffer,
        alerts: n8nAlertBuffer
    }
);

// Health Controller
const healthController = new HealthController(healthService);

// ============================================================================
// ROTAS
// ============================================================================

app.get('/health', (req, res) => healthController.getHealth(req, res));

// ============================================================================
// CACHE E SINCRONIZAÇÃO
// ============================================================================

/**
 * Atualiza cache de configurações de sensores
 */
const atualizarCacheSensores = async () => {
    try {
        logger.logDebug('CACHE', 'Iniciando atualização de cache de sensores...');
        const configs = await sensorRepository.findAllConfigs();
        
        const novoCache = new Map();
        const novaBlocklist = new Set(); 
        let ultracongeladores = 0;
        let emManutencao = 0;

        configs.forEach(c => {
            const macFormatted = formatarMac(c.mac);
            if (macFormatted) {
                novoCache.set(macFormatted, c);
                if (c.temp_min && c.temp_min < -15) ultracongeladores++;
                if (c.em_manutencao) emManutencao++;
            }
            if (c.sensor_porta_vinculado && c.sensor_porta_vinculado.length > 5) {
                novaBlocklist.add(formatarMac(c.sensor_porta_vinculado));
            }
        });
        
        const removidos = configCache.size - novoCache.size;
        configCache.clear();
        novoCache.forEach((v, k) => configCache.set(k, v));
        secondarySensorsBlocklist.clear();
        novaBlocklist.forEach(v => secondarySensorsBlocklist.add(v));

        logger.logInfo('CACHE', `Cache atualizado: ${configCache.size} sensores ativos`, {
            total: configCache.size,
            ultracongeladores,
            em_manutencao: emManutencao,
            sensores_secundarios: novaBlocklist.size,
            removidos: removidos > 0 ? removidos : 0
        });
    } catch (e) { 
        logger.logError('CACHE', 'Erro ao atualizar cache', {
            error: e.message,
            stack: e.stack
        });
    }
};

/**
 * Carrega último estado de portas do banco
 */
const carregarUltimoEstadoPortas = async () => {
    // Importa SensorState dinamicamente
    const { SensorState } = await import('./src/models/SensorState.js');
    try {
        logger.logDebug('PORTA_SYNC', 'Carregando último estado das portas do banco...');
        const doorStates = await sensorRepository.findLastDoorStates(24);
        
        if (!doorStates || doorStates.length === 0) {
            logger.logInfo('PORTA_SYNC', 'Nenhum estado de porta encontrado no banco');
            return;
        }
        
        const ultimoEstadoPorSensor = new Map();
        doorStates.forEach(log => {
            const mac = formatarMac(log.sensor_mac);
            if (mac && !ultimoEstadoPorSensor.has(mac)) {
                ultimoEstadoPorSensor.set(mac, {
                    is_open: log.is_open,
                    timestamp: log.timestamp_read
                });
            }
        });
        
        let portasCarregadas = 0;
        let portasAbertas = 0;
        let portasFechadas = 0;
        
        // Importa SensorState uma vez no início
        const { SensorState } = await import('./src/models/SensorState.js');
        
        ultimoEstadoPorSensor.forEach((estado, mac) => {
            if (configCache.has(mac)) {
                const config = configCache.get(mac);
                // Usa método público para criar ou obter estado
                const state = sensorService.getOrCreateSensorState(mac, config);
                
                state.alertControl.last_virtual_state = estado.is_open;
                state.alertControl.last_porta_state_loaded_ts = new Date(estado.timestamp).getTime();
                portasCarregadas++;
                if (estado.is_open) {
                    portasAbertas++;
                } else {
                    portasFechadas++;
                }
            }
        });
        
        logger.logInfo('PORTA_SYNC', `Estados de porta carregados: ${portasCarregadas} sensores`, {
            total_carregados: portasCarregadas,
            portas_abertas: portasAbertas,
            portas_fechadas: portasFechadas,
            estados_encontrados: ultimoEstadoPorSensor.size,
            sensores_no_cache: configCache.size
        });
    } catch (e) {
        logger.logError('PORTA_SYNC', 'Erro ao carregar estados de porta', {
            error: e.message,
            stack: e.stack 
        });
    }
};

/**
 * Sincroniza gateways conhecidos
 */
const sincronizarGatewaysConhecidos = async () => {
    try {
        logger.logDebug('GW_SYNC', 'Sincronizando gateways conhecidos do banco...');
        const gatewayData = await sensorRepository.findKnownGateways(24);
        
        let novos = 0;
        gatewayData.forEach(log => {
            const gwMac = formatarMac(log.gw);
            if (gwMac && !gatewayHeartbeats.has(gwMac)) {
                gatewayHeartbeats.set(gwMac, { 
                    last_seen: new Date(log.ts).getTime(), 
                    source: 'DB' 
                });
                novos++;
            }
        });

        logger.logInfo('GW_SYNC', `Gateways sincronizados: ${gatewayHeartbeats.size} total`, {
            novos_adicionados: novos,
            total_gateways: gatewayHeartbeats.size
        });
    } catch (e) {
        logger.logError('GW_SYNC', 'Erro ao sincronizar gateways', {
            error: e.message,
            stack: e.stack
        });
    }
};

// Inicialização
setTimeout(async () => {
    await atualizarCacheSensores();
    await carregarUltimoEstadoPortas();
    await sincronizarGatewaysConhecidos();
}, 1000);

// Atualizações periódicas
setInterval(atualizarCacheSensores, 10 * 60 * 1000);
setInterval(sincronizarGatewaysConhecidos, 30 * 60 * 1000);

// ============================================================================
// TAREFAS DE FUNDO
// ============================================================================

/**
 * Persiste telemetria e logs de porta em lote
 */
setInterval(async () => {
    // Telemetria
    if (dbTelemetryBuffer.length > 0) {
        const batch = [...dbTelemetryBuffer];
        dbTelemetryBuffer.length = 0;
        try {
            await sensorRepository.insertTelemetryBatch(batch);
            logger.logInfo('DB', `Salvos ${batch.length} logs de telemetria`, {
                total: batch.length,
                sensores_unicos: new Set(batch.map(b => b.mac)).size,
                gateways_unicos: new Set(batch.map(b => b.gw)).size
            });
        } catch (e) {
            logger.logError('DB', 'Erro ao salvar telemetria', {
                batch_size: batch.length,
                error: e.message 
            });
            dbTelemetryBuffer.unshift(...batch);
        }
    }

    // Portas
    if (dbDoorBuffer.length > 0) {
        const batch = [...dbDoorBuffer];
        dbDoorBuffer.length = 0;
        try {
            await sensorRepository.insertDoorBatch(batch);
            logger.logInfo('DB', `Salvos ${batch.length} logs de porta virtual`, {
                total: batch.length,
                aberturas: batch.filter(b => b.is_open).length,
                fechamentos: batch.filter(b => !b.is_open).length
            });
        } catch (e) {
            logger.logError('DB', 'Erro ao salvar logs de porta', {
                batch_size: batch.length,
                error: e.message 
            });
            dbDoorBuffer.unshift(...batch);
        }
    }
}, DB_FLUSH_INTERVAL_MS);

/**
 * Envia alertas para N8N em lote
 */
setInterval(async () => {
    if (n8nAlertBuffer.length === 0) return;
    
    const payload = [...n8nAlertBuffer];
    n8nAlertBuffer.length = 0;

    const prioridades = payload.reduce((acc, a) => {
        acc[a.prioridade] = (acc[a.prioridade] || 0) + 1;
        return acc;
    }, {});
    
    logger.logInfo('N8N', `Enviando ${payload.length} alertas acumulados`, {
        total: payload.length,
        prioridades,
        sensores_unicos: new Set(payload.map(a => a.sensor_mac)).size
    });
    
    try {
        const response = await fetch('https://n8n.alcateia-ia.com/webhook/coldchain/alertas', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ 
                timestamp: new Date().toISOString(), 
                total_alertas: payload.length, 
                is_batched: true, 
                alertas: payload 
            })
        });
        
        if (!response.ok) {
            throw new Error(`HTTP ${response.status}: ${response.statusText}`);
        }
        
        logger.logInfo('N8N', 'Alertas enviados com sucesso', {
            total: payload.length,
            status: response.status
        });
    } catch (e) { 
        logger.logError('N8N', 'Falha ao enviar alertas', {
            total: payload.length,
            error: e.message,
            stack: e.stack 
        });
        n8nAlertBuffer.unshift(...payload);
    }
}, BATCH_ALERT_INTERVAL_MS);

/**
 * Monitora gateways offline
 */
setInterval(() => {
    const now = Date.now();
    gatewayHeartbeats.forEach((data, gmac) => {
            if (HARDCODED_BLOCKLIST.includes(gmac)) return;
        if (now - data.last_seen > GATEWAY_TIMEOUT_MS) {
            const minOffline = Math.floor((now - data.last_seen) / 60000);
            n8nAlertBuffer.push({
                sensor_nome: `GATEWAY ${gmac.slice(-5)}`,
                sensor_mac: gmac,
                prioridade: 'SISTEMA',
                mensagens: [`GATEWAY OFFLINE há ${minOffline} minutos.`],
                timestamp_iso: moment(now).tz(TIMEZONE_CONFIG).format(),
                dados_contexto: { tipo: "INFRAESTRUTURA" }
            });
            logger.logWarn('GATEWAY', `Gateway ${gmac} offline há ${minOffline} minutos`);
        }
    });
}, GATEWAY_CHECK_INTERVAL_MS);

/**
 * Limpa dados antigos
 */
setInterval(() => {
    const now = Date.now();
    const umDia = 24 * 60 * 60 * 1000;
    sensorService.cleanOldStates(umDia);
    
    for (const [gmac, data] of gatewayHeartbeats.entries()) {
        if ((now - data.last_seen) > (umDia * 2)) {
            gatewayHeartbeats.delete(gmac);
        }
    }
}, 24 * 60 * 60 * 1000);

/**
 * Limpa watchlist de alertas antigos (mais de 2x o soak time)
 * Remove entradas que já expiraram para evitar crescimento infinito da memória
 */
setInterval(() => {
    const now = Date.now();
    const cleanupThreshold = ALERT_SOAK_TIME_MS * 2; // Remove após 40 minutos (2x o soak time)
    
    let removidos = 0;
    for (const [key, timestamp] of alertWatchlist.entries()) {
        if ((now - timestamp) > cleanupThreshold) {
            alertWatchlist.delete(key);
            removidos++;
        }
    }
    
    if (removidos > 0) {
        logger.logInfo('WATCHLIST', `Limpeza de watchlist: ${removidos} entradas removidas`, {
            removidos,
            restantes: alertWatchlist.size
        });
    }
}, 30 * 60 * 1000); // Executa a cada 30 minutos

// ============================================================================
// MQTT
// ============================================================================

const TOPIC_DATA = '/alcateia/gateways/beacons/prd_ble_dat';

const client = mqtt.connect(process.env.MQTT_BROKER_URL || 'mqtt://broker.hivemq.com', {
    clientId: 'alcateia_neural_v5_' + Math.random().toString(16).substring(2, 8),
    clean: true,
    reconnectPeriod: 5000
});

client.on('connect', async () => {
    logger.logInfo('MQTT', 'Conectado ao broker', {
        broker: process.env.MQTT_BROKER_URL || 'mqtt://broker.hivemq.com',
        client_id: client.options.clientId,
        topic: TOPIC_DATA
    });
    client.subscribe(TOPIC_DATA);
    
    await atualizarCacheSensores(); 
    await carregarUltimoEstadoPortas();
    await sincronizarGatewaysConhecidos();
});

client.on('error', (error) => {
    logger.logError('MQTT', 'Erro de conexão', {
        error: error.message,
        stack: error.stack
    });
});

client.on('offline', () => {
    logger.logWarn('MQTT', 'Cliente desconectado');
});

client.on('reconnect', () => {
    logger.logInfo('MQTT', 'Reconectando...');
});

client.on('message', (topic, message) => {
    if (topic !== TOPIC_DATA) {
        logger.logDebug('MQTT', 'Mensagem recebida em tópico não monitorado', { topic });
        return;
    }
    
    try {
        const payload = JSON.parse(message.toString());
        const items = Array.isArray(payload) ? payload : [payload];
        const now = Date.now();
        
        logger.logDebug('MQTT', 'Mensagem MQTT recebida', {
            items_count: items.length,
            topic,
            payload_size: message.length
        });
        
        let sensoresProcessados = 0;
        let sensoresIgnorados = 0;
        const gatewaysProcessados = new Set();
        
        items.forEach(item => {
            const gatewayMac = formatarMac(item.gmac);
            
            if (HARDCODED_BLOCKLIST.includes(gatewayMac)) {
                logger.logDebug('MQTT', 'Gateway na blocklist ignorado', { gateway: gatewayMac });
                return;
            }
            
            if (gatewayMac) {
                gatewayHeartbeats.set(gatewayMac, { last_seen: now });
                gatewaysProcessados.add(gatewayMac);
            }
            
            if (!item.obj || !Array.isArray(item.obj)) {
                logger.logDebug('MQTT', 'Item sem sensores', { gateway: gatewayMac });
                return;
            }
            
            item.obj.forEach(sensor => {
                const mac = formatarMac(sensor.dmac);
                
                if (!mac) {
                    sensoresIgnorados++;
                    return;
                }
                
                if (HARDCODED_BLOCKLIST.includes(mac)) {
                    logger.logDebug('MQTT', 'Sensor na blocklist ignorado', { sensor: mac });
                    sensoresIgnorados++;
                    return;
                }
                
                if (secondarySensorsBlocklist.has(mac)) {
                    logger.logDebug('MQTT', 'Sensor secundário ignorado', { sensor: mac });
                    sensoresIgnorados++;
                    return;
                }
                
                const config = configCache.get(mac);
                if (!config) {
                    logger.logDebug('MQTT', 'Sensor não encontrado no cache', { sensor: mac });
                    sensoresIgnorados++;
                    return;
                }
                
                // Processa sensor usando o serviço
                const result = sensorService.verificarSensor(mac, sensor, gatewayMac, config);

                // Processa alerta
                if (result?.alert) {
                    n8nAlertBuffer.push(result.alert);
                    logger.logWarn('ALERTA', `${config.display_name}: ${result.alert.mensagens[0]}`, {
                        sensor: mac,
                        prioridade: result.alert.prioridade,
                        buffer_size: n8nAlertBuffer.length
                    });
                }
                
                // Processa evento de porta
                if (result?.door) {
                    dbDoorBuffer.push(result.door);
                    logger.logDebug('DB', 'Evento de porta adicionado ao buffer', {
                        sensor: mac,
                        is_open: result.door.is_open,
                        buffer_size: dbDoorBuffer.length
                    });
                }

                // Processa telemetria
                const state = sensorService.getSensorState(mac);
                if (state && sensor.temp !== undefined) {
                    const last = state.lastReading;
                    const diffTemp = Math.abs(sensor.temp - last.db_temp);
                    const diffHum = Math.abs((sensor.humidity || 0) - last.db_hum);
                    const timeSinceLastDB = now - last.db_ts;
                    
                    if (diffTemp >= DB_MIN_VAR_TEMP || diffHum >= DB_MIN_VAR_HUM || timeSinceLastDB > DB_HEARTBEAT_MS) {
                        // Verifica se o sensor está em estado de degelo
                        const isDefrosting = state.alertControl?.is_defrosting || false;
                        
                        dbTelemetryBuffer.push({ 
                            gw: item.gmac, 
                            mac: mac, 
                            ts: new Date().toISOString(), 
                            temp: sensor.temp, 
                            hum: sensor.humidity, 
                            batt: calcularBateria(sensor.vbatt), 
                            rssi: sensor.rssi,
                            is_degelo: isDefrosting
                        });
                        
                        logger.logDebug('DB', 'Telemetria adicionada ao buffer', {
                            sensor: mac,
                            temp: sensor.temp,
                            diff_temp: diffTemp.toFixed(2),
                            diff_hum: diffHum.toFixed(2),
                            time_since_last: Math.floor(timeSinceLastDB / 1000),
                            is_degelo: isDefrosting,
                            buffer_size: dbTelemetryBuffer.length
                        });
                        
                        state.lastReading.db_temp = sensor.temp;
                        state.lastReading.db_hum = sensor.humidity;
                        state.lastReading.db_ts = now;
                    }
                }

                sensoresProcessados++;
            });
        });
        
        logger.logDebug('MQTT', 'Mensagem processada', {
            items: items.length,
            sensores_processados: sensoresProcessados,
            sensores_ignorados: sensoresIgnorados,
            gateways: Array.from(gatewaysProcessados),
            buffer_telemetry: dbTelemetryBuffer.length,
            buffer_alertas: n8nAlertBuffer.length
        });
        
    } catch (e) { 
        logger.logError('MQTT', 'Erro ao processar mensagem', {
            error: e.message,
            stack: e.stack,
            message_preview: message.toString().substring(0, 200)
        });
    }
});

// ============================================================================
// SHUTDOWN
// ============================================================================

const shutdown = async () => {
    logger.logInfo('SYSTEM', 'Encerrando sistema...');
    client.end(); 
    if (dbTelemetryBuffer.length > 0) {
        await sensorRepository.insertTelemetryBatch(dbTelemetryBuffer);
    }
    process.exit(0);
};

process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);

// ============================================================================
// SERVER
// ============================================================================

const PORT = process.env.PORT || 3030;
app.listen(PORT, () => {
    logger.logInfo('SYSTEM', 'Monitor ColdChain Neural v5 Online', {
        porta: PORT,
        log_level: process.env.LOG_LEVEL || 'debug',
        timezone: TIMEZONE_CONFIG,
        mqtt_broker: process.env.MQTT_BROKER_URL || 'mqtt://broker.hivemq.com'
    });
});
