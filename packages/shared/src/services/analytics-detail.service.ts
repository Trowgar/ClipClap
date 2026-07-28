import { prisma } from "../lib/prisma";
import { isLocalToday } from "../config/analytics";

/** Rows per page. Chosen for a phone screen, where the Mini App lives. */
export const PAGE_SIZE = 25;

export interface Page {
  page: number;
  pageSize: number;
  skip: number;
  totalPages: number;
  /** 1-based index of the first row shown, 0 when the table is empty. */
  from: number;
  /** 1-based index of the last row shown, 0 when the table is empty. */
  to: number;
  total: number;
}

/**
 * Resolves a requested page against a row count.
 *
 * Clamps rather than rejects: `?page=99` comes from a stale bookmark or a
 * shrinking table, and the last page is a more useful answer than an empty one.
 */
export function paginate(total: number, requested: number, pageSize = PAGE_SIZE): Page {
  const totalPages = Math.max(1, Math.ceil(total / pageSize));
  const page = Math.min(Math.max(1, Math.floor(requested) || 1), totalPages);
  const skip = (page - 1) * pageSize;
  return {
    page,
    pageSize,
    skip,
    totalPages,
    from: total === 0 ? 0 : skip + 1,
    to: Math.min(skip + pageSize, total),
    total,
  };
}
