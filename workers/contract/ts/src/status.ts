// helm.episode.status.v1 payloads and the A2A message parts that carry them.

import { STATUS_MEDIA_TYPE, STATUS_SCHEMA, type ErrorCode } from "./constants.js";

export interface WaitingOn {
  attempts?: string[];
  children?: string[];
  input?: { question: string; options: string[] };
}

export interface ReportSummary {
  status: "done" | "blocked" | "failed";
  summary: string;
}

export interface StatusPayload {
  schema: typeof STATUS_SCHEMA;
  waiting_on?: WaitingOn;
  error?: { code: ErrorCode; message: string };
  report?: ReportSummary;
}

/** A wire-format A2A part (text, data, ...); only what workers read or write is typed. */
export interface WirePart {
  text?: string;
  data?: unknown;
  mediaType?: string;
  [member: string]: unknown;
}

export function statusPayload(fields: {
  waitingOn?: WaitingOn;
  error?: { code: ErrorCode; message: string };
  report?: ReportSummary;
}): StatusPayload {
  const payload: StatusPayload = { schema: STATUS_SCHEMA };
  if (fields.waitingOn) payload.waiting_on = fields.waitingOn;
  if (fields.error) payload.error = fields.error;
  if (fields.report) payload.report = fields.report;
  return payload;
}

/** The wire-format parts of a status message: a text summary and the data part. */
export function statusParts(text: string, payload: StatusPayload): WirePart[] {
  return [
    { text, mediaType: "text/plain" },
    { data: payload, mediaType: STATUS_MEDIA_TYPE },
  ];
}

/** The event-metadata mirror of a status payload: every member except `schema`. */
export function statusMetadata(payload: StatusPayload): Record<string, unknown> {
  const { schema: _schema, ...rest } = payload;
  return rest;
}

export function findStatusPayload(parts: readonly WirePart[]): unknown {
  for (const part of parts) {
    if (part.mediaType === STATUS_MEDIA_TYPE && "data" in part) return part.data;
  }
  return undefined;
}
