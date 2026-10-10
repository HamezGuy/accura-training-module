import { getRoleByName, ROLES } from '@accura-trial/auth-core';
import { config } from '../config/environment';
import type { ReadableStreamDefaultReader } from 'node:stream/web';
import type { TrainingObligationScope, TrainingImpactSource,TrainingMaterialSource } from '../types/training.types';

/** Request-local native credentials; never persist or serialize this context. */
export interface TrainingAuthorityContext {
  readonly actorUserId: number;
  readonly accessToken: string;
  readonly signal?: AbortSignal;
}
export type TrainingAuthorityAction = 'compliance:read' | 'records:read' | 'records:verify' | 'records:expiring';
export interface TrainingDirectoryFilter { userId?: number; studyId?: number }
export interface TrainingDirectoryUser {
  userId: number;
  username: string;
  firstName: string | null;
  lastName: string | null;
  role: string;
  reportOrder: number;
  observationHash: string;
}
export interface TrainingDirectory {
  users: TrainingDirectoryUser[];
  filter: TrainingDirectoryFilter;
  scopeFingerprint: string;
  upperUserId: number;
}
export interface TrainingTargetResult {
  scopeFingerprint: string;
  decisions: Array<{ userId: number; allowed: boolean }>;
}

const PAGE_SIZE = 200;
const MAX_BODY_BYTES = 8 * 1024 * 1024;
const MAX_IN_FLIGHT = 4;
const HASH = /^sha256:[a-f0-9]{64}$/;
const MAX_NATIVE_ID = 2147483647;
const isId = (value: unknown): value is number => Number.isSafeInteger(value) && (value as number) > 0 && (value as number) <= MAX_NATIVE_ID;
const isBound = (value: unknown): value is number => value === 0 || isId(value);
const isRecord = (value: unknown): value is Record<string, unknown> => value !== null && typeof value === 'object' && !Array.isArray(value);
function canonicalWire(value:any):string {if(Array.isArray(value))return `[${value.map(canonicalWire).join(',')}]`;if(isRecord(value))return `{${Object.keys(value).sort().map(key=>`${JSON.stringify(key)}:${canonicalWire(value[key])}`).join(',')}}`;return JSON.stringify(value);}
// Persisted JSONB may reorder object keys. Exact values/array order matter;
// property insertion order is not part of the authority wire contract.
const same = (a: unknown, b: unknown): boolean => canonicalWire(a) === canonicalWire(b);

class TrainingAuthorityFailure extends Error {
  constructor(public readonly statusCode: number, message: string, public readonly code: string) { super(message); }
}
function fail(statusCode: number, message: string, code = 'TRAINING_AUTHORITY_UNAVAILABLE'): never {
  throw new TrainingAuthorityFailure(statusCode, message, code);
}
function invalid(): never { return fail(503, 'Training authority returned an invalid response'); }
function validContext(context: TrainingAuthorityContext): void {
  if (!context || !isId(context.actorUserId) || typeof context.accessToken !== 'string' || !context.accessToken.trim()) {
    fail(503, 'Training authority context is unavailable');
  }
}
function filterValue(filter: TrainingDirectoryFilter = {}): TrainingDirectoryFilter {
  if (!isRecord(filter) || Object.keys(filter).some(key => !['userId', 'studyId'].includes(key))) {
    fail(400, 'An exact training directory filter is required', 'TRAINING_AUTHORITY_INVALID_REQUEST');
  }
  const userId = filter.userId, studyId = filter.studyId;
  if ((userId !== undefined && !isId(userId)) || (studyId !== undefined && !isId(studyId))) {
    fail(400, 'An exact positive native user or study ID is required', 'TRAINING_AUTHORITY_INVALID_REQUEST');
  }
  return { ...(userId === undefined ? {} : { userId }), ...(studyId === undefined ? {} : { studyId }) };
}
function matchesFilter(value: unknown, filter: TrainingDirectoryFilter): boolean {
  return isRecord(value) && Object.keys(value).every(key => ['userId', 'studyId'].includes(key))
    && value.userId === filter.userId && value.studyId === filter.studyId;
}

/** Fixed-origin transport; credentials never follow redirects or enter errors. */
export class TrainingAuthorityTransport {
  private active = 0;
  constructor(private readonly options: { baseUrl: string; timeoutMs: number }, private readonly fetcher: typeof fetch = (...args) => fetch(...args)) {}

  async resolve(context: TrainingAuthorityContext, input: Record<string, unknown>): Promise<Record<string, unknown>> {
    validContext(context);
    let url: URL;
    try { url = new URL(this.options.baseUrl); } catch { return fail(503, 'Training authority configuration is unavailable'); }
    if (!['https:', 'http:'].includes(url.protocol) || url.username || url.password || url.pathname !== '/' || url.search || url.hash
      || !Number.isSafeInteger(this.options.timeoutMs) || this.options.timeoutMs < 1 || this.options.timeoutMs > 30000) {
      fail(503, 'Training authority configuration is unavailable');
    }
    if (context.signal?.aborted) fail(503, 'Training authority request was cancelled');
    if (this.active >= MAX_IN_FLIGHT) fail(503, 'Training authority is busy; retry the request', 'TRAINING_AUTHORITY_BUSY');
    this.active += 1;
    const controller = new AbortController();
    const abort = () => controller.abort();
    context.signal?.addEventListener('abort', abort, { once: true });
    const timer = setTimeout(abort, this.options.timeoutMs);
    let reader: ReadableStreamDefaultReader<Uint8Array> | undefined;
    try {
      const response = await this.fetcher(new URL('/api/training-authority/resolve', url.origin), {
        method: 'POST', redirect: 'error', signal: controller.signal,
        headers: { Authorization: `Bearer ${context.accessToken}`, 'Content-Type': 'application/json', Accept: 'application/json', 'Cache-Control': 'no-store' },
        body: JSON.stringify({ schemaVersion: 'training-authority-request/1', ...input }),
      });
      if (!/^application\/json(?:\s*;|$)/i.test(response.headers.get('content-type') ?? '') || !response.body) invalid();
      const length = response.headers.get('content-length');
      if (length !== null && (!/^\d+$/.test(length) || Number(length) > MAX_BODY_BYTES)) invalid();
      reader = response.body.getReader();
      const chunks: Buffer[] = [];
      let bytes = 0;
      while (true) {
        const chunk = await reader.read();
        if (chunk.done) break;
        bytes += chunk.value.byteLength;
        if (bytes > MAX_BODY_BYTES) invalid();
        chunks.push(Buffer.from(chunk.value));
      }
      if (controller.signal.aborted) fail(503, 'Training authority request was cancelled');
      const body: unknown = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(Buffer.concat(chunks, bytes)));
      if (!response.ok) {
        const code = isRecord(body) && isRecord(body.error) && typeof body.error.code === 'string' && /^[A-Z][A-Z0-9_]{0,79}$/.test(body.error.code)
          ? body.error.code : 'TRAINING_AUTHORITY_UNAVAILABLE';
        if (response.status === 401 || response.status === 403) fail(response.status,
          code === 'PASSWORD_EXPIRED' ? 'Password expired. Change your password before continuing.' : 'Authentication or training access refused by the account authority', code);
        if (response.status === 404 && code === 'TRAINING_AUTHORITY_STUDY_NOT_FOUND') fail(404, 'Study not found for training compliance', code);
        if (response.status === 409 && code === 'TRAINING_AUTHORITY_ROLE_INVALID') fail(409, 'Unknown native platform role for training compliance', code);
        if (response.status === 409 && code === 'TRAINING_AUTHORITY_SCOPE_INVALID') fail(409, 'The study, site or arm is no longer an active native scope', code);
        if (response.status === 409 && ['TRAINING_AUTHORITY_SCOPE_CHANGED', 'TRAINING_AUTHORITY_SELECTION_CHANGED'].includes(code)) {
          fail(409, 'Training authority changed during the request; retry the report', code);
        }
        fail(503, 'Training authority is unavailable', code);
      }
      if (!isRecord(body) || body.success !== true || !isRecord(body.data)) invalid();
      const data = body.data;
      if (data.schemaVersion !== 'training-authority/1' || data.actorUserId !== context.actorUserId || data.op !== input.op || data.action !== input.action
        || typeof data.observedAt !== 'string' || !Number.isFinite(Date.parse(data.observedAt))
        || data.consistency !== 'current-page-observations-not-atomic' || typeof data.scopeFingerprint !== 'string' || !HASH.test(data.scopeFingerprint)) invalid();
      if (input.expectedScopeFingerprint !== undefined && data.scopeFingerprint !== input.expectedScopeFingerprint) {
        fail(409, 'Training authority changed during the request; retry the report', 'TRAINING_AUTHORITY_SCOPE_CHANGED');
      }
      return data;
    } catch (error) {
      if (error instanceof TrainingAuthorityFailure) throw error;
      return fail(503, 'Training authority is unavailable');
    } finally {
      controller.abort();
      try { await reader?.cancel(); } catch { /* Transport cleanup must not hide the original refusal. */ }
      context.signal?.removeEventListener('abort', abort);
      clearTimeout(timer);
      this.active -= 1;
    }
  }
}

const transport = new TrainingAuthorityTransport(config.authority);

export async function observeTrainingInspection(context:TrainingAuthorityContext,nativeStudyId:number,materials:TrainingMaterialSource[]=[],expectedScopeFingerprint?:string,impacts:Array<{scope:{studyId:number;siteId?:number};source:TrainingImpactSource}>=[]){
 const started=Date.now();const data=await transport.resolve(context,{op:'inspection',action:'records:inspect',nativeStudyId,materials,impacts,...(expectedScopeFingerprint?{expectedScopeFingerprint}:{})});
 if(data.complete!==true||data.nativeStudyId!==nativeStudyId||!Array.isArray(data.studyIds)||!data.studyIds.length||data.studyIds.length>500||data.studyIds.some(v=>!isId(v))||new Set(data.studyIds).size!==data.studyIds.length
  ||!Array.isArray(data.scopes)||data.scopes.length!==data.studyIds.length||data.scopes.some((s:any,i)=>!isRecord(s)||Object.keys(s).some(k=>!['studyId','siteId'].includes(k))||!isId(s.studyId)||s.siteId!==undefined&&!isId(s.siteId)||(s.siteId??s.studyId)!==(data.studyIds as number[])[i])
  ||typeof data.authorityHash!=='string'||!/^[a-f0-9]{64}$/.test(data.authorityHash)||data.scopeFingerprint!==`sha256:${data.authorityHash}`
  ||!Array.isArray(data.sourceChecks)||data.sourceChecks.length!==materials.length||data.sourceChecks.some((c:any,i)=>!isRecord(c)||Object.keys(c).some(k=>!['sourceHash','current'].includes(k))||c.sourceHash!==materials[i]!.sourceHash||typeof c.current!=='boolean')
  ||!Array.isArray(data.impactChecks)||data.impactChecks.length!==impacts.length||data.impactChecks.some((c:any,i)=>!isRecord(c)||Object.keys(c).some(k=>!['nativeSourceHash','lifecycleRevision','current'].includes(k))||c.nativeSourceHash!==impacts[i]!.source.nativeSourceHash||c.lifecycleRevision!==impacts[i]!.source.lifecycleRevision||typeof c.current!=='boolean')
  ||Date.parse(data.observedAt as string)<started-5000||Date.parse(data.observedAt as string)>Date.now()+5000)invalid();
 return {nativeStudyId,studyIds:data.studyIds as number[],scopes:data.scopes as Array<{studyId:number;siteId?:number}>,authorityHash:data.authorityHash,
  scopeFingerprint:data.scopeFingerprint as string,sourceChecks:data.sourceChecks as Array<{sourceHash:string;current:boolean}>,impactChecks:data.impactChecks as Array<{nativeSourceHash:string;lifecycleRevision:number;current:boolean}>};
}

export async function observeMaterialSource(context:TrainingAuthorityContext,source:Omit<TrainingMaterialSource,'sourceHash'>&{sourceHash?:string},
 options:{learner?:{userId:number;scope:TrainingObligationScope};reviewer?:{userId:number;authorityHash:string};authorityHash?:string}={}){
 const data=await transport.resolve(context,{op:'material-source',action:options.learner?'duties:read':'obligations:manage',...source,
  ...(options.learner?{userId:options.learner.userId,learnerScope:options.learner.scope}:{}),...(options.reviewer?{reviewer:options.reviewer}:{})});
 if(data.complete!==true||!same(data.scope,source.scope)||!same(data.armIds,source.armIds)||!same(data.originals,source.originals)
  ||typeof data.sourceHash!=='string'||!/^[a-f0-9]{64}$/.test(data.sourceHash)||source.sourceHash!==undefined&&data.sourceHash!==source.sourceHash
  ||typeof data.actorAuthorityHash!=='string'||!HASH.test(data.actorAuthorityHash)
  ||options.authorityHash!==undefined&&data.actorAuthorityHash!==options.authorityHash)invalid();
 return {source:{scope:source.scope,armIds:source.armIds,originals:source.originals,sourceHash:data.sourceHash},authorityHash:data.actorAuthorityHash as string|undefined};
}

export interface ObligationScopeObservation {
  scope: TrainingObligationScope; userId: number; eligible: boolean; roles: string[]; observationHash: string; scopeFingerprint: string;
}
export interface ImpactSourceObservation {
  scope:{studyId:number;siteId?:number};source:TrainingImpactSource;
  sourceObservationHash:string;scopeFingerprint:string;actorAuthorityHash:string;
}
/** Native source custody must be resolved by the existing authority, never a posted approval flag. */
export async function resolveImpactSource(context:TrainingAuthorityContext,scope:ImpactSourceObservation['scope'],source:TrainingImpactSource,
  expected?:ImpactSourceObservation,reviewer?:{userId:number;authorityHash:string}):Promise<ImpactSourceObservation>{
  const data=await transport.resolve(context,{op:'impact-source',action:'obligations:manage',scope,source,...(reviewer?{reviewer}:{}),
    ...(expected?{expectedScopeFingerprint:expected.scopeFingerprint}:{})});
  if(data.complete!==true||!same(data.scope,scope)||!same(data.source,source)
    ||typeof data.sourceObservationHash!=='string'||!HASH.test(data.sourceObservationHash)||typeof data.actorAuthorityHash!=='string'||!HASH.test(data.actorAuthorityHash))invalid();
  const observed={scope,source,sourceObservationHash:data.sourceObservationHash,scopeFingerprint:data.scopeFingerprint as string,actorAuthorityHash:data.actorAuthorityHash};
  if(expected&&expected.sourceObservationHash!==observed.sourceObservationHash)fail(409,'The native training impact source changed; review a new plan','TRAINING_AUTHORITY_SELECTION_CHANGED');
  return observed;
}
export async function inspectImpactSource(context:TrainingAuthorityContext,scope:ImpactSourceObservation['scope'],originals:TrainingImpactSource['originals']):Promise<ImpactSourceObservation>{
  const data=await transport.resolve(context,{op:'impact-source',action:'obligations:manage',scope,originals});
  if(data.complete!==true||!same(data.scope,scope)||!isRecord(data.source)||!same(data.source.originals,originals)
    ||typeof data.source.nativeSourceHash!=='string'||!/^[a-f0-9]{64}$/.test(data.source.nativeSourceHash)
    ||!isBound(data.source.lifecycleRevision)||typeof data.sourceObservationHash!=='string'||!HASH.test(data.sourceObservationHash)
    ||typeof data.actorAuthorityHash!=='string'||!HASH.test(data.actorAuthorityHash))invalid();
  return {scope,source:data.source as unknown as TrainingImpactSource,sourceObservationHash:data.sourceObservationHash,
    scopeFingerprint:data.scopeFingerprint as string,actorAuthorityHash:data.actorAuthorityHash};
}
export async function resolveObligationScope(context: TrainingAuthorityContext, action: 'obligations:read' | 'obligations:manage' | 'obligations:withdraw' | 'duties:read',
  userId: number, scope: TrainingObligationScope, expected?: ObligationScopeObservation): Promise<ObligationScopeObservation> {
  const data = await transport.resolve(context, { op: 'obligation', action, userId, scope,
    ...(expected ? { expectedScopeFingerprint: expected.scopeFingerprint } : {}) });
  if (data.complete !== true || data.userId !== userId || !isRecord(data.scope) || !same(data.scope, scope)
    || typeof data.eligible !== 'boolean' || !Array.isArray(data.roles) || data.roles.some(role => typeof role !== 'string' || getRoleByName(role).name !== role || role === ROLES.INVALID.name)
    || typeof data.observationHash !== 'string' || !HASH.test(data.observationHash)) invalid();
  const result = data as unknown as ObligationScopeObservation;
  if (expected && expected.observationHash !== result.observationHash) fail(409, 'Learner scope changed during the operation; refresh before retrying', 'TRAINING_AUTHORITY_SELECTION_CHANGED');
  return result;
}

export async function readTrainingDirectory(context: TrainingAuthorityContext, requestedFilter: TrainingDirectoryFilter = {}): Promise<TrainingDirectory> {
  const filter = filterValue(requestedFilter);
  const users: TrainingDirectoryUser[] = [];
  const reportOrders = new Set<number>();
  let afterUserId = 0;
  let upperUserId: number | undefined;
  let scopeFingerprint: string | undefined;
  while (true) {
    const data = await transport.resolve(context, { op: 'directory', action: 'compliance:read', filter,
      page: { afterUserId, limit: PAGE_SIZE, ...(upperUserId === undefined ? {} : { upperUserId }) },
      ...(scopeFingerprint === undefined ? {} : { expectedScopeFingerprint: scopeFingerprint }) });
    if (!matchesFilter(data.filter, filter) || !Array.isArray(data.users) || data.users.length > PAGE_SIZE || !isRecord(data.page)) invalid();
    const page = data.page;
    if (page.afterUserId !== afterUserId || page.limit !== PAGE_SIZE || !isBound(page.upperUserId)
      || (upperUserId !== undefined && page.upperUserId !== upperUserId) || typeof page.hasMore !== 'boolean'
      || page.complete !== !page.hasMore || data.complete !== !page.hasMore) invalid();
    upperUserId = page.upperUserId;
    scopeFingerprint = data.scopeFingerprint as string;
    let last = afterUserId;
    for (const value of data.users) {
      if (!isRecord(value) || !isId(value.userId) || value.userId <= last || value.userId > upperUserId
        || (filter.userId !== undefined && value.userId !== filter.userId) || typeof value.username !== 'string'
        || (value.firstName !== null && typeof value.firstName !== 'string') || (value.lastName !== null && typeof value.lastName !== 'string')
        || typeof value.role !== 'string' || getRoleByName(value.role).name !== value.role || getRoleByName(value.role).id === ROLES.INVALID.id
        || !isId(value.reportOrder) || typeof value.observationHash !== 'string' || !HASH.test(value.observationHash)) invalid();
      if (reportOrders.has(value.reportOrder)) fail(409, 'Training authority changed during the request; retry the report', 'TRAINING_AUTHORITY_SELECTION_CHANGED');
      reportOrders.add(value.reportOrder);
      users.push(value as unknown as TrainingDirectoryUser);
      last = value.userId;
    }
    if (page.hasMore) {
      if (!data.users.length || page.nextAfterUserId !== last || last >= upperUserId) invalid();
      afterUserId = last;
    } else {
      if (page.nextAfterUserId !== null) invalid();
      break;
    }
  }
  // EDC supplies native database collation order; never guess it with JS locale.
  users.sort((left, right) => left.reportOrder - right.reportOrder);
  return { users, filter, scopeFingerprint, upperUserId };
}

export async function authorizeTrainingTargets(context: TrainingAuthorityContext, action: TrainingAuthorityAction, userIds: number[], options: {
  scopeFingerprint?: string; filter?: TrainingDirectoryFilter; users?: TrainingDirectoryUser[]; upperUserId?: number;
} = {}): Promise<TrainingTargetResult> {
  if (!Array.isArray(userIds) || userIds.some(id => !isId(id)) || new Set(userIds).size !== userIds.length) {
    fail(400, 'Exact unique native user IDs are required', 'TRAINING_AUTHORITY_INVALID_REQUEST');
  }
  const filter = filterValue(options.filter);
  if (options.scopeFingerprint !== undefined && !HASH.test(options.scopeFingerprint)) invalid();
  if (options.users && (!same(options.users.map(user => user.userId), userIds) || options.users.some(user => !HASH.test(user.observationHash)))) invalid();
  if (options.users && !isBound(options.upperUserId)) invalid();
  let scopeFingerprint = options.scopeFingerprint;
  const decisions: TrainingTargetResult['decisions'] = [];
  // Empty requests still validate the live actor, including an empty report.
  for (let offset = 0; offset < Math.max(1, userIds.length); offset += PAGE_SIZE) {
    const batch = userIds.slice(offset, offset + PAGE_SIZE);
    const data = await transport.resolve(context, { op: 'targets', action, userIds: batch,
      ...(action === 'compliance:read' ? { filter } : {}),
      ...(options.upperUserId === undefined ? {} : { upperUserId: options.upperUserId }),
      ...(options.users ? { userObservations: options.users.slice(offset, offset + PAGE_SIZE).map(user => ({ userId: user.userId, hash: user.observationHash })) } : {}),
      ...(scopeFingerprint === undefined ? {} : { expectedScopeFingerprint: scopeFingerprint }) });
    if (data.complete !== true || !same(data.userIds, batch) || !Array.isArray(data.decisions) || data.decisions.length !== batch.length
      || (action === 'compliance:read' && !matchesFilter(data.filter, filter))
      || (options.upperUserId !== undefined && data.upperUserId !== options.upperUserId)) invalid();
    scopeFingerprint = data.scopeFingerprint as string;
    data.decisions.forEach((value, index) => {
      if (!isRecord(value) || value.userId !== batch[index] || typeof value.allowed !== 'boolean') invalid();
      decisions.push({ userId: value.userId as number, allowed: value.allowed as boolean });
    });
  }
  return { scopeFingerprint: scopeFingerprint!, decisions };
}

export async function revalidateTrainingDirectory(context: TrainingAuthorityContext, directory: TrainingDirectory): Promise<void> {
  const checked = await authorizeTrainingTargets(context, 'compliance:read', directory.users.map(user => user.userId), {
    scopeFingerprint: directory.scopeFingerprint, filter: directory.filter, users: directory.users, upperUserId: directory.upperUserId,
  });
  if (checked.decisions.some(decision => !decision.allowed)) {
    fail(409, 'Training authority changed during the request; retry the report', 'TRAINING_AUTHORITY_SELECTION_CHANGED');
  }
}
