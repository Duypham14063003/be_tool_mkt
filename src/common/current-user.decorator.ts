import { createParamDecorator, ExecutionContext } from '@nestjs/common';
import { AuthUser } from './auth.types';
export const CurrentUser = createParamDecorator((_data: unknown, ctx: ExecutionContext): AuthUser => ctx.switchToHttp().getRequest<{ user: AuthUser }>().user);
