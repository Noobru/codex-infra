import crypto from "node:crypto"
import fs from "node:fs/promises"
import path from "node:path"

export function nowIso() {
  return new Date().toISOString()
}

export function makeId(prefix = "item") {
  return `${prefix}_${crypto.randomUUID()}`
}

export function slugify(value) {
  return String(value)
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 80)
}

export async function readJson(filePath, fallback) {
  try {
    return JSON.parse(await fs.readFile(filePath, "utf8"))
  } catch (error) {
    if (error?.code === "ENOENT") return structuredClone(fallback)
    throw error
  }
}

export async function atomicWriteJson(filePath, data) {
  await fs.mkdir(path.dirname(filePath), { recursive: true })
  const temporary = `${filePath}.${crypto.randomUUID()}.tmp`
  await fs.writeFile(temporary, `${JSON.stringify(data, null, 2)}\n`, "utf8")
  await fs.rename(temporary, filePath)
}

/** Publish a fully written immutable file atomically, preserving EEXIST/idempotency. */
export async function atomicWriteNew(filePath, content) {
  await fs.mkdir(path.dirname(filePath), { recursive: true })
  const temporary = `${filePath}.${crypto.randomUUID()}.tmp`
  try {
    await fs.writeFile(temporary, content, {encoding:'utf8',flag:'wx'})
    await fs.link(temporary, filePath)
  } finally {
    await fs.unlink(temporary).catch(error => {if(error.code !== 'ENOENT') throw error})
  }
}

export function isSubPath(candidate, allowedRoot) {
  const relative = path.relative(path.resolve(allowedRoot), path.resolve(candidate))
  return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative))
}

export async function isRealSubPath(candidate, allowedRoot) {
  return Boolean(await resolveRealSubPath(candidate, allowedRoot))
}

export async function resolveRealSubPath(candidate, allowedRoot) {
  try {
    const [realCandidate, realRoot] = await Promise.all([fs.realpath(candidate), fs.realpath(allowedRoot)])
    return isSubPath(realCandidate, realRoot) ? realCandidate : null
  } catch {
    return null
  }
}

export function clampText(value, maxLength) {
  const text = String(value ?? "").trim()
  if (!text || text.length > maxLength) return null
  return text
}

export function parseDate(value) {
  const date = new Date(value)
  return Number.isNaN(date.getTime()) ? null : date
}

export function errorMessage(error) {
  return error instanceof Error ? error.message : String(error)
}
