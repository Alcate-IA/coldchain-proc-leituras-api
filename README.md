# ColdChain Neural v5 - API de Monitoramento de Sensores

API de monitoramento de sensores de temperatura para cadeia de frio, com arquitetura refatorada utilizando Design Patterns e algoritmos melhorados de detecção.

## 🏗️ Arquitetura

O projeto foi refatorado seguindo os princípios SOLID e Design Patterns, organizando o código em camadas bem definidas:

```
coldchain-proc-leituras-api/
├── src/
│   ├── config/          # Configurações e constantes
│   ├── controllers/     # Controllers HTTP (MVC)
│   ├── models/          # Modelos de dados
│   ├── repositories/     # Acesso a dados (Repository Pattern)
│   ├── services/        # Lógica de negócio
│   ├── strategies/      # Estratégias de detecção (Strategy Pattern)
│   └── utils/           # Utilitários
├── logs/                # Logs do sistema
├── index.js             # Ponto de entrada da aplicação
└── package.json
```

## 🎯 Design Patterns Implementados

### 1. **Strategy Pattern**
- **`DoorDetectionStrategy`**: Estratégia de detecção de porta aberta/fechada
- **`DefrostDetectionStrategy`**: Estratégia de detecção de ciclo de degelo
- Permite trocar algoritmos de detecção sem modificar o código principal

### 2. **Repository Pattern**
- **`SensorRepository`**: Abstrai acesso ao banco de dados Supabase
- Centraliza operações de persistência
- Facilita testes e manutenção

### 3. **Service Layer**
- **`SensorService`**: Orquestra lógica de negócio
- **`ThermalAnalysisService`**: Análise estatística avançada
- **`HealthService`**: Geração de relatórios de saúde do sistema

### 4. **MVC (Model-View-Controller)**
- **Controllers**: `HealthController` - endpoints HTTP
- **Models**: `SensorState` - representação de estado
- **Views**: JSON responses

### 5. **Singleton Pattern**
- **Logger**: Instância única de logger Winston

## 🚀 Melhorias Implementadas

### 1. **Detecção de Portas Abertas/Fechadas**

#### Melhorias:
- **Confirmação Temporal**: Aguarda múltiplas detecções antes de confirmar mudança de estado
- **Múltiplos Critérios**: 5 critérios diferentes para detecção de abertura
- **Análise de Estabilidade**: Verifica se temperatura está estável dentro do range antes de detectar porta
- **Redução de Falsos Positivos**: Histórico de estados para validação

#### Critérios de Detecção:
1. **Aceleração Súbita**: Mudança rápida na taxa de variação
2. **Slope Alto**: Subida violenta de temperatura
3. **Alta Variância + Baixo R²**: Turbulência térmica
4. **Mudança de Ponto**: Análise de segmentos mostra mudança significativa
5. **Jerk Alto**: Mudança abrupta na aceleração

### 2. **Ciclo de Degelo**

#### Melhorias:
- **Análise de Fases**: Detecta fase RISING, FALLING, PEAK
- **Múltiplos Critérios**: 4 critérios para início, 5 para fim
- **Proteção Temporal**: Não permite fim imediatamente após início
- **Análise de Padrão Completo**: Detecta ciclo completo (subida → pico → descida)
- **Tuning Específico**: Parâmetros diferentes para ultracongeladores

#### Critérios de Início:
1. Subida linear estável (slope + R² + variância)
2. Padrão de ciclo detectado
3. Para ultracongeladores: slope alto com R² bom
4. Análise de segmentos mostra mudança significativa

#### Critérios de Fim:
1. Descida forte e consistente
2. Fase de descida do ciclo detectada
3. Timeout de segurança (60 minutos)
4. Temperatura voltou próxima do início
5. Análise de segmentos mostra descida consistente

### 3. **Endpoint /health Melhorado**

O endpoint `/health` agora retorna informações muito mais detalhadas:

```json
{
  "status": "UP",
  "timestamp": "2024-01-01T12:00:00.000Z",
  "uptime": {
    "seconds": 3600,
    "formatted": "1h 0min"
  },
  "system": {
    "node_version": "v18.0.0",
    "memory": {
      "used_mb": 150,
      "total_mb": 200,
      "rss_mb": 180,
      "external_mb": 10
    },
    "cpu_usage": {...},
    "platform": "win32"
  },
  "sensors": {
    "total": 50,
    "with_data": 48,
    "in_defrost": 2,
    "door_open": 1,
    "in_maintenance": 0,
    "ultracongeladores": 10,
    "detail": [
      {
        "nome": "Sensor 01",
        "mac": "AA:BB:CC:DD:EE:FF",
        "temp": -18.5,
        "humidity": 65.0,
        "status": "OK 🟢",
        "last_seen": {
          "timestamp": "2024-01-01T12:00:00.000Z",
          "ago_seconds": 5,
          "ago_formatted": "5s"
        },
        "ia_metrics": {
          "slope": 0.05,
          "r2": 0.92,
          "variance": 0.3,
          "std_error": 0.15,
          "acceleration": 0.02,
          "jerk": 0.01,
          "ema": -18.3,
          "history_points": 120
        },
        "thermal_trend": {
          "direction": "STABLE",
          "confidence": "HIGH",
          "projected_15min": -18.2
        },
        "defrost_info": null,
        "door_info": {
          "is_open": false,
          "last_state_change": "2024-01-01T11:00:00.000Z",
          "state_duration_min": 60
        },
        "config": {
          "temp_max": -5.0,
          "temp_min": -30.0,
          "hum_max": 80,
          "hum_min": 40,
          "is_ultra": true,
          "em_manutencao": false
        }
      }
    ]
  },
  "gateways": {
    "total": 5,
    "active": 4,
    "offline": 1,
    "last_seen": "2024-01-01T12:00:00.000Z"
  },
  "buffers": {
    "telemetry": {
      "size": 100,
      "oldest_entry": "2024-01-01T11:50:00.000Z"
    },
    "door": {
      "size": 5,
      "oldest_entry": "2024-01-01T11:55:00.000Z"
    },
    "alerts": {
      "size": 2,
      "oldest_entry": "2024-01-01T11:58:00.000Z"
    }
  },
  "performance": {
    "event_loop_lag": 0.5,
    "active_handles": 10,
    "active_requests": 2
  },
  "alerts": {
    "watchlist_size": 0,
    "recent_alerts": 0
  }
}
```

## 📊 Métricas de IA por Sensor

Cada sensor no `/health` inclui métricas detalhadas de análise térmica:

- **slope**: Taxa de variação de temperatura (°C/min)
- **r2**: Coeficiente de determinação (confiança da tendência)
- **variance**: Dispersão dos dados
- **std_error**: Erro padrão (turbulência)
- **acceleration**: Mudança no slope
- **jerk**: Mudança na aceleração
- **ema**: Média móvel exponencial
- **thermal_trend**: Direção e confiança da tendência
- **projected_15min**: Projeção de temperatura em 15 minutos

## 🔧 Configuração

### Variáveis de Ambiente

```env
SUPABASE_URL=your_supabase_url
SUPABASE_KEY=your_supabase_key
MQTT_BROKER_URL=mqtt://broker.hivemq.com
PORT=3030
LOG_LEVEL=debug
GLOBAL_TEMP_MAX=-5.0
GLOBAL_TEMP_MIN=-30.0
```

### Instalação

```bash
npm install
npm start
```

## 📝 Estrutura de Código

### Configurações (`src/config/`)
- `constants.js`: Todas as constantes e parâmetros de tuning

### Utilitários (`src/utils/`)
- `logger.js`: Logger centralizado (Singleton)
- `formatters.js`: Funções de formatação

### Modelos (`src/models/`)
- `SensorState.js`: Representa estado e histórico de um sensor

### Repositórios (`src/repositories/`)
- `SensorRepository.js`: Acesso ao banco de dados

### Serviços (`src/services/`)
- `SensorService.js`: Lógica principal de processamento
- `ThermalAnalysisService.js`: Análise estatística avançada
- `HealthService.js`: Geração de relatórios de saúde

### Estratégias (`src/strategies/`)
- `DetectionStrategy.js`: Interface base
- `DoorDetectionStrategy.js`: Detecção de porta
- `DefrostDetectionStrategy.js`: Detecção de degelo

### Controllers (`src/controllers/`)
- `HealthController.js`: Endpoint /health

## 🎛️ Tuning de Parâmetros

Os parâmetros de detecção podem ser ajustados em `src/config/constants.js`:

### Para Refrigeração Normal (0°C a -10°C)
- `TUNING_NORMAL`: Parâmetros otimizados para câmaras normais

### Para Ultracongeladores (< -15°C)
- `TUNING_ULTRA`: Parâmetros mais sensíveis para ultracongeladores

### Detecção de Porta
- `DOOR_DETECTION`: Parâmetros de confirmação temporal

### Ciclo de Degelo
- `DEFROST_DETECTION`: Parâmetros de detecção de fases

## 🔒 Segurança e LGPD

- Dados sensíveis processados apenas no backend
- Logs não expõem informações pessoais
- Comunicação via HTTPS/MQTT seguro
- Validação e sanitização de todas as entradas

## 📈 Performance

- Processamento assíncrono de mensagens MQTT
- Buffers em memória para escrita em lote no banco
- Limpeza automática de dados antigos
- Cache de configurações de sensores

## 🧪 Testes

```bash
# Executar testes (quando implementados)
npm test
```

## 📝 Logs

Os logs são salvos em:
- `logs/error.log`: Apenas erros
- `logs/combined.log`: Todos os logs (debug)

## 🤝 Contribuindo

1. Siga os padrões de código estabelecidos
2. Mantenha cobertura de testes acima de 80%
3. Documente mudanças significativas
4. Use commits semânticos (feat:, fix:, refactor:)

## 📄 Licença

ISC

---

**Desenvolvido com ❤️ seguindo as melhores práticas de engenharia de software**
