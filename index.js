import mqtt from 'mqtt';
import { createClient } from '@supabase/supabase-js';
import dotenv from 'dotenv';
import express from 'express';
import cors from 'cors';

dotenv.config();

// --- CONFIGURAÇÕES ---
const PORT = process.env.PORT || 3000;
const BROKER_URL = 'mqtt://broker.hivemq.com';
const TOPIC = '/alcateia/gateways/beacons/prd_ble_dat';

// --- INICIALIZAÇÃO ---
const app = express();
const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_KEY);
const client = mqtt.connect(BROKER_URL);

// --- MIDDLEWARES ---
app.use(cors());
app.use(express.json());

// --- FUNÇÕES AUXILIARES ---
const formatarMac = (mac) => {
    if (!mac) return null;
    if (mac.includes(':')) return mac;
    return mac.replace(/(.{2})(?=.)/g, '$1:');
};

const calcularBateria = (mVolts) => {
    if (!mVolts) return 0;
    const MAX_MV = 3600;
    const MIN_MV = 2500;
    if (mVolts >= MAX_MV) return 100;
    if (mVolts <= MIN_MV) return 0;
    return Math.round(((mVolts - MIN_MV) / (MAX_MV - MIN_MV)) * 100);
};

// --- FUNÇÃO: VERIFICAÇÃO DE ALERTAS (CORRIGIDA) ---
const processarAlertas = async (leituras) => {
    if (leituras.length === 0) return;

    // Extrai MACs únicos
    const macs = [...new Set(leituras.map(l => l.mac))];
    
    console.log(`🔍 Validando regras para ${macs.length} sensores únicos...`);

    // 1. Busca configurações com os NOMES DE COLUNA CORRETOS
    const { data: configs, error } = await supabase
        .from('sensor_configs')
        .select('mac, display_name, temp_max, hum_max, batt_warning') // <--- CORRIGIDO AQUI
        .in('mac', macs);

    if (error) {
        console.error('❌ Erro ao buscar configurações:', error.message);
        return;
    }

    if (!configs || configs.length === 0) {
        console.log('ℹ️ Nenhuma configuração encontrada para estes sensores. Pulando validação.');
        return;
    }

    console.log(`⚙️ Configurações encontradas para ${configs.length} sensores.`);

    const configMap = new Map(configs.map(c => [c.mac, c]));
    const alertasParaSalvar = [];

    // Itera sobre as leituras e compara
    leituras.forEach(leitura => {
        const config = configMap.get(leitura.mac);
        if (!config) return;

        // Helper para logar o alerta
        const logAlerta = (tipo, valor, limite) => {
            console.log(`⚠️ [ALERTA] ${config.display_name || leitura.mac} | ${tipo}: ${valor} (Limite: ${limite})`);
        };

        // 2. Validação de Temperatura (temp_max)
        if (config.temp_max !== null && leitura.temp > config.temp_max) {
            logAlerta('Temperatura', leitura.temp, config.temp_max);
            alertasParaSalvar.push({
                sensor_mac: leitura.mac,
                gateway_mac: leitura.gw,
                display_name: config.display_name,
                alert_type: 'Temperatura',
                read_value: leitura.temp,
                limit_value: config.temp_max
            });
        }

        // 3. Validação de Umidade (hum_max)
        if (config.hum_max !== null && leitura.hum > config.hum_max) {
            logAlerta('Umidade', leitura.hum, config.hum_max);
            alertasParaSalvar.push({
                sensor_mac: leitura.mac,
                gateway_mac: leitura.gw,
                display_name: config.display_name,
                alert_type: 'Umidade',
                read_value: leitura.hum,
                limit_value: config.hum_max
            });
        }

        // 4. Validação de Bateria (batt_warning)
        if (config.batt_warning !== null && leitura.batt > config.batt_warning) {
            logAlerta('Bateria', leitura.batt, config.batt_warning);
            alertasParaSalvar.push({
                sensor_mac: leitura.mac,
                gateway_mac: leitura.gw,
                display_name: config.display_name,
                alert_type: 'Bateria',
                read_value: leitura.batt,
                limit_value: config.batt_warning
            });
        }
    });

    // Salva os alertas
    if (alertasParaSalvar.length > 0) {
        const { error: errInsert } = await supabase
            .from('critical_logs')
            .insert(alertasParaSalvar);
        
        if (errInsert) console.error('❌ Erro ao salvar tabela critical_logs:', errInsert.message);
        else console.log(`🚨 ${alertasParaSalvar.length} alertas persistidos no banco!`);
    } else {
        console.log('✅ Nenhum parâmetro crítico excedido.');
    }
};



// --- LÓGICA MQTT ---
client.on('connect', () => {
    console.log('✅ Conectado ao MQTT!');
    client.subscribe(TOPIC);
});

client.on('message', async (topic, message) => {
    try {
        const msgString = message.toString();
        let payload = JSON.parse(msgString);
        let leiturasParaSalvar = [];

        // --- DETECÇÃO DE FORMATO E PARSE ---

        // 1. Formato Novo
        if (payload.gw && payload.mac && payload.ts) {
            leiturasParaSalvar.push({
                gw: formatarMac(payload.gw),
                mac: formatarMac(payload.mac),
                rssi: payload.rssi,
                ts: payload.ts,
                batt: payload.batt,
                temp: payload.temp,
                hum: payload.hum
            });
        } 
        // 2. Formato Antigo
        else {
            while (Array.isArray(payload) && payload.length > 0 && Array.isArray(payload[0])) {
                payload = payload.flat();
            }
            const gateways = Array.isArray(payload) ? payload : [payload];

            gateways.forEach(gatewayMsg => {
                const gatewayMac = gatewayMsg.gmac;
                if (gatewayMac && gatewayMsg.obj && Array.isArray(gatewayMsg.obj)) {
                    gatewayMsg.obj.forEach(sensor => {
                        if (sensor.type === 1) {
                            leiturasParaSalvar.push({
                                gw: formatarMac(gatewayMac),
                                mac: formatarMac(sensor.dmac),
                                rssi: sensor.rssi,
                                ts: sensor.time ? sensor.time.replace(' ', 'T') : new Date().toISOString(),
                                batt: calcularBateria(sensor.vbatt),
                                temp: sensor.temp,
                                hum: sensor.humidity
                            });
                        }
                    });
                }
            });
        }

        // --- PROCESSAMENTO PRINCIPAL ---
        if (leiturasParaSalvar.length > 0) {
            
            // 1. Verifica Alertas (Logs detalhados estão dentro da função)
            await processarAlertas(leiturasParaSalvar);

            // 2. Salva Telemetria Padrão
            const { error } = await supabase
                .from('telemetry_logs')
                .insert(leiturasParaSalvar);

            if (error) {
                console.error('❌ Erro Supabase:', error.message);
            } else {
                console.log(`💾 Telemetria: ${leiturasParaSalvar.length} registros salvos.`);
            }
        }

    } catch (e) {
        console.error('❌ Erro crítico:', e.message);
    }
});

app.listen(PORT, () => console.log(`🚀 API rodando na porta ${PORT}`));