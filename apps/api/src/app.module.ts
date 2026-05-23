import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { ConfigSchema, validateConfig } from './config';
import { HealthController } from './health/health.controller';
import { PrismaModule } from './prisma/prisma.module';
import { AuthModule } from './auth/auth.module';

@Module({
  imports: [
    ConfigModule.forRoot({
      isGlobal: true,
      cache: true,
      validate: validateConfig,
    }),
    PrismaModule,
    AuthModule,
  ],
  controllers: [HealthController],
})
export class AppModule {}

export type AppConfig = ConfigSchema;
