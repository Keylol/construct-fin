import { ArgumentMetadata, BadRequestException, PipeTransform } from '@nestjs/common';
import { ZodSchema, ZodError } from 'zod';

/**
 * Pipe для валидации body/query/param через zod-схему.
 * Использование: `@Body(new ZodPipe(MySchema)) body: MyType`.
 */
export class ZodPipe<T> implements PipeTransform<unknown, T> {
  constructor(private readonly schema: ZodSchema<T>) {}

  transform(value: unknown, _meta: ArgumentMetadata): T {
    try {
      return this.schema.parse(value);
    } catch (e) {
      if (e instanceof ZodError) {
        throw new BadRequestException({
          message: 'Validation failed',
          issues: e.issues.map((i) => ({ path: i.path, message: i.message })),
        });
      }
      throw e;
    }
  }
}
