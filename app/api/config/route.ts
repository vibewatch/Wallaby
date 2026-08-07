import type { Prisma, UserPreference } from "@prisma/client";
import { z } from "zod";

import { authenticateApiRequest, unauthorized } from "@/lib/api-auth";
import { db } from "@/lib/db";
import { sanitizeReaderCss } from "@/lib/preferences";
import { themes } from "@/lib/theme";

export async function GET(request: Request) {
  const userId = await authenticateApiRequest(request);
  if (!userId) return unauthorized();
  const config = await db.userPreference.upsert({ where: { userId }, update: {}, create: { userId } });
  return Response.json(serializeConfig(config));
}

export async function PATCH(request: Request) {
  const userId = await authenticateApiRequest(request);
  if (!userId) return unauthorized();
  const flag = z.union([z.boolean(), z.number()]).transform(Boolean);
  const parsed = z.object({
    items_per_page: z.number().int().min(5).max(100).optional(),
    language: z.string().trim().min(2).max(20).optional(),
    reading_speed: z.number().min(50).max(1_000).optional(),
    feed_limit: z.number().int().min(1).max(1_000).optional(),
    action_mark_as_read: flag.optional(),
    list_mode: flag.optional(),
    display_thumbnails: flag.optional(),
    theme: z.enum(themes).optional(),
    font: z.enum(["sans", "serif"]).optional(),
    fontsize: z.number().min(0.75).max(2).optional(),
    line_height: z.number().min(1.2).max(2.5).optional(),
    max_width: z.number().int().min(480).max(1_400).optional(),
    custom_css: z.string().max(20_000).nullable().optional(),
  }).safeParse(await request.json().catch(() => null));
  if (!parsed.success) return Response.json({ error: "Invalid configuration", issues: parsed.error.issues }, { status: 400 });
  let customCss: string | null | undefined;
  try { customCss = parsed.data.custom_css === undefined ? undefined : sanitizeReaderCss(parsed.data.custom_css ?? ""); }
  catch (error) { return Response.json({ error: error instanceof Error ? error.message : "Invalid custom CSS" }, { status: 400 }); }
  const data: Prisma.UserPreferenceUncheckedUpdateInput = {
    itemsPerPage: parsed.data.items_per_page,
    language: parsed.data.language,
    readingSpeed: parsed.data.reading_speed,
    feedLimit: parsed.data.feed_limit,
    actionMarkAsRead: parsed.data.action_mark_as_read,
    listMode: parsed.data.list_mode,
    displayThumbnails: parsed.data.display_thumbnails,
    theme: parsed.data.theme,
    font: parsed.data.font,
    fontSize: parsed.data.fontsize,
    lineHeight: parsed.data.line_height,
    maxWidth: parsed.data.max_width,
    customCss,
  };
  await db.userPreference.upsert({ where: { userId }, create: { userId }, update: {} });
  const config = await db.userPreference.update({ where: { userId }, data });
  return Response.json(serializeConfig(config));
}

function serializeConfig(config: UserPreference) {
  return {
    id: config.id,
    items_per_page: config.itemsPerPage,
    language: config.language,
    feed_token: config.feedToken,
    feed_limit: config.feedLimit,
    reading_speed: config.readingSpeed,
    action_mark_as_read: Number(config.actionMarkAsRead),
    list_mode: Number(config.listMode),
    display_thumbnails: Number(config.displayThumbnails),
    theme: config.theme,
    font: config.font,
    fontsize: config.fontSize,
    line_height: config.lineHeight,
    max_width: config.maxWidth,
    custom_css: config.customCss,
  };
}
