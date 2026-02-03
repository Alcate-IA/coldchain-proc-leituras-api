/**
 * Controller para endpoint de health check
 * Implementa padrão MVC
 */

import logger from '../utils/logger.js';

export class HealthController {
    constructor(healthService) {
        this.healthService = healthService;
    }

    /**
     * Handler do endpoint GET /health
     */
    async getHealth(req, res) {
        try {
            logger.logDebug('HEALTH', 'Health check acessado');
            
            const healthReport = this.healthService.generateHealthReport();
            
            logger.logDebug('HEALTH', 'Health check respondido', {
                total_sensors: healthReport.sensors.total,
                gateways: healthReport.gateways.total,
                sensores_com_dados: healthReport.sensors.with_data
            });

            res.json(healthReport);
        } catch (error) {
            logger.logError('HEALTH', 'Erro ao gerar health report', {
                error: error.message,
                stack: error.stack
            });
            
            res.status(500).json({
                status: 'ERROR',
                message: 'Erro ao gerar relatório de saúde',
                error: error.message
            });
        }
    }
}
