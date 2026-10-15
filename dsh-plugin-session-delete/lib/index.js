/**
 * dsh-plugin-session-delete — Host half.
 *
 * Permanently removes one stored Session: its durable JSONL log directory, its
 * projection-cache checkpoint, and its Workspace / pin / archive accounting.
 *
 * The Host exposes exactly one Typert Remote endpoint,
 * `sessionDelete/deleteSession`, discovered in source mode (SRC) from the
 * `@Remote` marker applied to the service method below, so the plugin needs no
 * generated descriptor artifacts and no build step.
 *
 * @module dsh-plugin-session-delete
 */
import { readdir, rm, stat } from "node:fs/promises";
import { dirname, join } from "node:path";
import { Remote, RemoteError, TypertRemoteService } from "@deepseek-ai/dsh-typert-protocol";

/** Stable Remote failure-code prefix. */
const CODE_PREFIX = "sessionDelete";

/**
 * Encode one string exactly as the shipped JSONL backend names a session
 * directory. Safe code units stay literal; every other unit (including `~`)
 * becomes `~XXXX`, and the two dot segments are special-cased. This mirrors
 * `dsh-session-persistence-jsonl`'s `encodeSegment`, used only for the
 * backend-agnostic directory fallback below.
 * @param raw - Session id to encode.
 * @returns the injectively escaped single path segment.
 */
function encodeSegment(raw) {
  if (raw === ".") return "~002E";
  if (raw === "..") return "~002E~002E";
  let out = "";
  for (let index = 0; index < raw.length; index += 1) {
    const code = raw.charCodeAt(index);
    const character = String.fromCharCode(code);
    if (character !== "~" && /^[A-Za-z0-9._-]$/u.test(character)) out += character;
    else out += `~${code.toString(16).toUpperCase().padStart(4, "0")}`;
  }
  return out;
}

/**
 * Apply the Typert `@Remote` marker to one class method without a build-time
 * decorator. TypeScript's standard method decorator is an ordinary function of
 * `(value, context)`; replaying its `addInitializer` callback against a
 * throwaway receiver whose prototype is the owning class writes the marker onto
 * that same prototype, which is what the Gateway reads.
 * @param Class - Service class owning the method.
 * @param method - Public instance method exporting the endpoint.
 */
function markRemote(Class, method) {
  const descriptor = Object.getOwnPropertyDescriptor(Class.prototype, method);
  if (descriptor === undefined || typeof descriptor.value !== "function") {
    throw new TypeError(`session-delete: ${Class.name}.${method} must be a public class method`);
  }
  const initializers = [];
  Remote(method)(descriptor.value, {
    kind: "method",
    name: method,
    static: false,
    private: false,
    addInitializer(initializer) {
      initializers.push(initializer);
    },
  });
  const receiver = Object.create(Class.prototype);
  for (const initializer of initializers) initializer.call(receiver);
}

/**
 * Test one path without throwing.
 * @param target - Absolute path.
 * @returns whether the path exists.
 */
async function exists(target) {
  try {
    await stat(target);
    return true;
  } catch {
    return false;
  }
}

/**
 * Locate every session directory holding one id under a persistence root, for
 * backends that expose their root but no authoritative artifact path.
 * @param root - Session persistence root directory.
 * @param sessionId - Stored Session identity.
 * @returns existing `<root>/<projectDir>/<encoded-id>` directories.
 */
async function findSessionDirectories(root, sessionId) {
  const encoded = encodeSegment(sessionId);
  const found = [];
  let entries;
  try {
    entries = await readdir(root, { withFileTypes: true });
  } catch {
    return found;
  }
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const candidate = join(root, entry.name, encoded);
    if (await exists(candidate)) found.push(candidate);
  }
  return found;
}

/** Remove one directory when it is already empty; a non-empty one is left alone. */
async function removeIfEmpty(directory) {
  try {
    const entries = await readdir(directory);
    if (entries.length > 0) return false;
    await rm(directory, { recursive: true, force: true });
    return true;
  } catch {
    return false;
  }
}

/**
 * Session deletion service: one Remote method, `sessionDelete/deleteSession`.
 */
class SessionDeleteService extends TypertRemoteService {
  /**
   * @param ctx - Host context carrying the composed Session, persistence,
   * Workspace, and storage services.
   */
  constructor(ctx) {
    super(ctx, "sessionDelete", { namespace: "sessionDelete" });
  }

  /**
   * Permanently delete one stored Session.
   *
   * Refuses a Session this process currently holds open, because its live write
   * handle owns the log. Everything else is removed: the durable log directory,
   * the projection-cache checkpoint, and the Workspace, pin, and archive
   * accounting. The deletion is not recoverable.
   * @param sessionId - Stored Session identity.
   * @returns the removed absolute paths.
   * @throws RemoteError when the id is invalid, the Session is live, unknown, or a removal fails.
   */
  async deleteSession(sessionId) {
    if (typeof sessionId !== "string" || sessionId.length === 0) {
      throw new RemoteError(
        `${CODE_PREFIX}/invalid-request`,
        "deleteSession requires a non-empty session id",
        { sessionId: typeof sessionId === "string" ? sessionId : "" },
      );
    }
    const sessions = this.ctx.get("sessions");
    if (sessions !== undefined && sessions.get(sessionId) !== undefined) {
      throw new RemoteError(
        `${CODE_PREFIX}/session-live`,
        `session "${sessionId}" is open in this process; close it before deleting`,
        { sessionId },
      );
    }
    const persistence = this.ctx.get("sessionPersistence");
    if (persistence === undefined) {
      throw new RemoteError(
        `${CODE_PREFIX}/unavailable`,
        "session deletion requires a mounted session persistence backend",
        { sessionId },
      );
    }
    const snapshot = await persistence.stat(sessionId);
    if (snapshot === undefined) {
      throw new RemoteError(
        `${CODE_PREFIX}/not-found`,
        `session "${sessionId}" does not exist`,
        { sessionId },
      );
    }

    await this.releaseCatalog(sessionId);
    await this.dropProjectionCache(sessionId);

    const removed = [];
    const directories = await this.sessionDirectories(persistence, snapshot.header, sessionId);
    for (const directory of directories) {
      try {
        await rm(directory, { recursive: true, force: true });
      } catch (error) {
        throw new RemoteError(
          `${CODE_PREFIX}/remove-failed`,
          `failed to remove "${directory}": ${error instanceof Error ? error.message : String(error)}`,
          { sessionId, path: directory },
          { cause: error },
        );
      }
      removed.push(directory);
      const parent = dirname(directory);
      if (await removeIfEmpty(parent)) removed.push(parent);
    }
    this.ctx.logger?.info?.(`session-delete: removed session ${sessionId} (${removed.length} path(s))`);
    return { sessionId, removed };
  }

  /**
   * Resolve the directories one Session owns. The shipped JSONL backend's
   * `locate()` is authoritative; a backend exposing only `root` is scanned.
   * @param persistence - Mounted session persistence backend.
   * @param header - Stored Session header.
   * @param sessionId - Stored Session identity.
   * @returns candidate session directories.
   */
  async sessionDirectories(persistence, header, sessionId) {
    if (typeof persistence.locate === "function") {
      try {
        const located = persistence.locate(header);
        const path = located === undefined || located === null ? undefined : located.path;
        if (typeof path === "string" && path.length > 0) return [dirname(path)];
      } catch {
        // fall through to the root scan
      }
    }
    const root = typeof persistence.root === "string" ? persistence.root : undefined;
    if (root === undefined) return [];
    return await findSessionDirectories(root, sessionId);
  }

  /**
   * Drop one Session from the durable Workspace registry: its pin, its archive
   * mark, and its accounting slot in the owning Workspace.
   * @param sessionId - Stored Session identity.
   */
  async releaseCatalog(sessionId) {
    const registry = this.ctx.get("workspaceRegistry");
    if (registry === undefined) return;
    try {
      await registry.unpinSession(sessionId);
    } catch (error) {
      this.ctx.logger?.warn?.(error);
    }
    try {
      await registry.unarchiveSession(sessionId);
    } catch (error) {
      this.ctx.logger?.warn?.(error);
    }
    let entities = [];
    try {
      entities = registry.list();
    } catch (error) {
      this.ctx.logger?.warn?.(error);
      return;
    }
    for (const entity of entities) {
      let member = false;
      try {
        member = Array.isArray(entity.sessionIds) && entity.sessionIds.includes(sessionId);
      } catch (error) {
        this.ctx.logger?.warn?.(error);
        continue;
      }
      if (!member) continue;
      try {
        await entity.detachSession(sessionId);
      } catch (error) {
        this.ctx.logger?.warn?.(error);
      }
    }
  }

  /**
   * Delete the Session's durable projection-cache checkpoint through the
   * storage domain's own write chain, so cache readers and the medium agree.
   * @param sessionId - Stored Session identity.
   */
  async dropProjectionCache(sessionId) {
    const facility = this.ctx.get("storageDomain");
    if (facility === undefined || typeof facility.get !== "function") return;
    let table;
    try {
      const domain = facility.get("session_projcache");
      table = domain === undefined ? undefined : domain.table("sessions");
    } catch (error) {
      this.ctx.logger?.warn?.(error);
      return;
    }
    if (table === undefined || typeof table.delete !== "function") return;
    try {
      await table.delete(sessionId);
    } catch (error) {
      this.ctx.logger?.warn?.(error);
    }
  }
}

markRemote(SessionDeleteService, "deleteSession");

/** Cordis plugin name. */
export const name = "session-delete";
export { SessionDeleteService };
export default SessionDeleteService;
