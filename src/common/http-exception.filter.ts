import { ArgumentsHost, Catch, ExceptionFilter, HttpException, HttpStatus } from '@nestjs/common';
import type { Response } from 'express';
import { CorrelatedRequest } from './correlation-id.middleware';
@Catch()
export class HttpExceptionFilter implements ExceptionFilter {
  catch(exception: unknown, host: ArgumentsHost): void {
    const context = host.switchToHttp(); const request = context.getRequest<CorrelatedRequest>(); const response = context.getResponse<Response>();
    const status = exception instanceof HttpException ? exception.getStatus() : HttpStatus.INTERNAL_SERVER_ERROR;
    const payload = exception instanceof HttpException ? exception.getResponse() : null;
    const rawMessage = typeof payload === 'string' ? payload : payload && typeof payload === 'object' && 'message' in payload ? (payload as { message: string | string[] }).message : 'Internal server error';
    const message = Array.isArray(rawMessage) ? rawMessage.join(', ') : rawMessage;
    const knownCode = /^[A-Z][A-Z0-9_]+$/.test(message) ? message : undefined;
    response.status(status).json({ statusCode: status, errorCode: knownCode ?? (status === 500 ? 'INTERNAL_SERVER_ERROR' : 'REQUEST_FAILED'), message, correlationId: request.correlationId });
  }
}
