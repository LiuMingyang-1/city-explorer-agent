import type { CollectedHit, SearchResponse, NormalRequest } from "./types.ts";
export interface StoredHit extends CollectedHit { documentId: string; }
export interface Snapshot { response: SearchResponse; pageEnds: number[]; }
export interface SearchRepository {
 beginRun(id: string, scope: string, request: NormalRequest, key: string, now: number, deadline: number): void;
 completeRun(id: string, hits: CollectedHit[], now: number, deadline: number, build: (hits: StoredHit[], conflicts: number) => Snapshot): Snapshot;
 failRun(id: string, status: "failed" | "cancelled", now: number): void;
 getSnapshot(id: string, scope: string, key: string, now: number, deadline: number): Snapshot;
 issueCursor(id: string, scope: string, offset: number, now: number, deadline: number): string;
 resolveCursor(token: string, scope: string, key: string, now: number, deadline: number): { snapshot: Snapshot; offset: number };
 cleanup(now: number): void;
 close(): void;
}
