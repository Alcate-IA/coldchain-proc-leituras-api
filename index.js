import mqtt from 'mqtt';
import { createClient } from '@supabase/supabase-js';
import dotenv from 'dotenv';

dotenv.config();

// Configurações
const BROKER_URL = 'mqtt://broker.hivemq.com';
const TOPIC = '/alcateia/gateways/beacons/prd_ble_dat';

// Inicializa Supabase
const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_KEY);

const client = mqtt.connect(BROKER_URL);

// --- FUNÇÃO PARA COLOCAR MÁSCARA NO MAC ---
const formatarMac = (mac) => {
    if (!mac) return null;
    // Se o MAC já tiver ":" (como no novo formato), não aplica a máscara novamente
    if (mac.includes(':')) return mac;
    return mac.replace(/(.{2})(?=.)/g, '$1:');
};

// --- FUNÇÃO PARA CALCULAR PORCENTAGEM DA BATERIA (FORMATO ANTIGO) ---
const calcularBateria = (mVolts) => {
    if (!mVolts) return 0;
    const MAX_MV = 3600; 
    const MIN_MV = 2500; 

    if (mVolts >= MAX_MV) return 100;
    if (mVolts <= MIN_MV) return 0;

    const porcentagem = ((mVolts - MIN_MV) / (MAX_MV - MIN_MV)) * 100;
    return Math.round(porcentagem);
};

client.on('connect', () => {
    console.log('✅ Conectado ao MQTT! Aguardando mensagens...');
    client.subscribe(TOPIC);
});

client.on('message', async (topic, message) => {
    try {
        const msgString = message.toString();
        let payload = JSON.parse(msgString);
        const leiturasParaSalvar = [];

        // --- DETECÇÃO DE FORMATO ---

        // VERIFICAÇÃO: Formato Novo (Objeto direto com chaves gw e mac)
        if (payload.gw && payload.mac && payload.ts) {
            console.log(`📥 Formato novo recebido do sensor: ${payload.mac}`);
            leiturasParaSalvar.push({
                gw: formatarMac(payload.gw),
                mac: formatarMac(payload.mac),
                rssi: payload.rssi,
                ts: payload.ts, // No novo formato já vem como ISO string
                batt: payload.batt, // No novo formato já vem como porcentagem
                temp: payload.temp,
                hum: payload.hum
            });
        } 
        // VERIFICAÇÃO: Formato Antigo (Nested arrays / Gateway logic)
        else {
            // Continua achatando enquanto o primeiro elemento for um array
            while (Array.isArray(payload) && payload.length > 0 && Array.isArray(payload[0])) {
                payload = payload.flat();
            }

            const gateways = Array.isArray(payload) ? payload : [payload];

            gateways.forEach(gatewayMsg => {
                const gatewayMac = gatewayMsg.gmac;

                if (gatewayMac && gatewayMsg.obj && Array.isArray(gatewayMsg.obj)) {
                    console.log(`📡 Processando formato antigo do gateway: ${gatewayMac}`);

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

        // --- SALVAR NO BANCO ---
        if (leiturasParaSalvar.length > 0) {
            const { error } = await supabase
                .from('telemetry_logs')
                .insert(leiturasParaSalvar);

            if (error) {
                console.error('❌ Erro ao salvar no Supabase:', error.message);
                console.error('Detalhes do erro:', error);
            } else {
                console.log(`💾 Sucesso! ${leiturasParaSalvar.length} registros inseridos.`);
            }
        }

    } catch (e) {
        console.error('❌ Erro crítico ao processar mensagem:', e.message);
    }
});

client.on('error', (err) => {
    console.error('❌ Erro de conexão MQTT:', err);
});