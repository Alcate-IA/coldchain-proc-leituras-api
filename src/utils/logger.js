/**
 * Logger centralizado usando Winston
 * Implementa padrão Singleton para garantir uma única instância
 */

import winston from 'winston';
import moment from 'moment-timezone';
import { TIMEZONE_CONFIG } from '../config/constants.js';

class Logger {
    constructor() {
        if (Logger.instance) {
            return Logger.instance;
        }

        this.logger = winston.createLogger({
            level: process.env.LOG_LEVEL || 'debug',
            format: winston.format.combine(
                winston.format.timestamp({ 
                    format: () => moment().tz(TIMEZONE_CONFIG).format('HH:mm:ss') 
                }),
                winston.format.printf(({ timestamp, level, message }) => 
                    `[${timestamp}] ${level.toUpperCase().padEnd(5)} | ${message}`
                )
            ),
            transports: [
                new winston.transports.File({ 
                    filename: 'logs/error.log', 
                    level: 'error' 
                }),
                new winston.transports.Console({ 
                    format: winston.format.colorize({ all: true }) 
                })
            ],
        });

        Logger.instance = this;
    }

    /**
     * Log estruturado por categoria
     */
    logDebug(categoria, mensagem, dados = {}) {
        const dadosStr = Object.keys(dados).length > 0 ? ` | ${JSON.stringify(dados)}` : '';
        this.logger.debug(`[${categoria}] ${mensagem}${dadosStr}`);
    }

    logInfo(categoria, mensagem, dados = {}) {
        const dadosStr = Object.keys(dados).length > 0 ? ` | ${JSON.stringify(dados)}` : '';
        this.logger.info(`[${categoria}] ${mensagem}${dadosStr}`);
    }

    logWarn(categoria, mensagem, dados = {}) {
        const dadosStr = Object.keys(dados).length > 0 ? ` | ${JSON.stringify(dados)}` : '';
        this.logger.warn(`[${categoria}] ${mensagem}${dadosStr}`);
    }

    logError(categoria, mensagem, dados = {}) {
        const dadosStr = Object.keys(dados).length > 0 ? ` | ${JSON.stringify(dados)}` : '';
        this.logger.error(`[${categoria}] ${mensagem}${dadosStr}`, dados);
    }

    // Métodos diretos para compatibilidade
    debug(message, meta) {
        this.logger.debug(message, meta);
    }

    info(message, meta) {
        this.logger.info(message, meta);
    }

    warn(message, meta) {
        this.logger.warn(message, meta);
    }

    error(message, meta) {
        this.logger.error(message, meta);
    }
}

export default new Logger();
