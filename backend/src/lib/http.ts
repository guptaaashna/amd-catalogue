import type { Request } from "express";
import { Prisma } from "@prisma/client";
import { z } from "zod";

export class HttpError extends Error {
  constructor(public readonly status: number, message: string, public readonly details?: unknown) {
    super(message);
    this.name = "HttpError";
  }
}

export function actorFrom(request: Request): string {
  const actor = request.header("x-actor")?.trim();
  return actor ? actor.slice(0, 128) : "system";
}

export function parseOrThrow<T>(schema: z.ZodType<T>, value: unknown): T {
  const parsed = schema.safeParse(value);
  if (!parsed.success) {
    throw new HttpError(400, "Validation failed", parsed.error.flatten());
  }
  return parsed.data;
}

export function toJson(value: unknown): Prisma.InputJsonValue {
  if (value === null) throw new HttpError(400, "A top-level JSON value cannot be null");
  try {
    const serialized = JSON.stringify(value);
    if (serialized === undefined) throw new Error("Value is not JSON-compatible");
    const parsed: unknown = JSON.parse(serialized);
    if (parsed === null) throw new Error("A top-level JSON value cannot be null");
    return parsed as Prisma.InputJsonValue;
  } catch (error) {
    if (error instanceof HttpError) throw error;
    throw new HttpError(400, "Value must be JSON-compatible");
  }
}

export function toJsonObject(value: unknown): Prisma.InputJsonObject {
  const parsed = toJson(value);
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    throw new HttpError(400, "Value must be a JSON object");
  }
  return parsed as Prisma.InputJsonObject;
}
