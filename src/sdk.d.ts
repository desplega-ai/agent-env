export type Provider = 'docker' | 'compose' | 'devcontainer' | 'sandbox' | 'e2b';
export type AgentEnvErrorCode = 'INVALID_ARGUMENT' | 'CLI_FAILED' | 'TRANSPORT_ERROR' | 'INVALID_RESPONSE' | 'OUTPUT_LIMIT';

export class AgentEnvError extends Error {
  constructor(message: string, options?: { code?: AgentEnvErrorCode; exitCode?: number; stderr?: string });
  readonly code: AgentEnvErrorCode;
  readonly exitCode?: number;
  /** Present only when includeErrorOutput is enabled. Application output can contain private values. */
  readonly stderr?: string;
}

export interface ClientOptions {
  /** Resolve relative paths from this directory. The SDK never changes process.cwd(). */
  cwd: string;
  /** Override AGENT_ENV_HOME. Resolve relative paths from cwd. */
  home?: string;
  /** Inherit process.env for each call. Use undefined to remove an inherited variable. */
  env?: Readonly<Record<string, string | undefined>>;
  /** Maximum combined CLI output in bytes. Default: 64 MiB. */
  maxOutputBytes?: number;
  /** Include CLI stderr in failed operation errors. Default: false. Treat this output as private. */
  includeErrorOutput?: boolean;
}

export interface UpOptions {
  name?: string;
  provider?: Provider;
  adapter?: string;
  ssh?: string;
  sshConfig?: string;
  local?: boolean;
  cloud?: 'hetzner';
  cloudType?: string;
  location?: string;
  idleMinutes?: number;
  ttlHours?: number;
  config?: string;
  environment?: string;
  /** Select files in order. Use false to disable automatic env file discovery. */
  envFiles?: readonly string[] | false;
  composeFiles?: readonly string[];
  profiles?: readonly string[];
  /** false disables synchronization watchers. true retains the configured behavior. */
  watch?: boolean;
  /** Integer seconds from 1 through 3600. This limits startup, not commands. */
  startupTimeoutSeconds?: number;
  /** Startup command arguments. The CLI applies its provider command rules. */
  command?: readonly string[];
  port?: number;
  image?: string;
}

export interface ResumeOptions { startupTimeoutSeconds?: number }
export interface ServiceOptions { service?: string }
export interface RemoveOptions {
  purge?: boolean;
  /** Acknowledge uncertain completion only after verifying that all allocation commands have stopped. */
  acceptUncertain?: boolean;
}
/** Local directory, s3://bucket/prefix, or storage://profile/key. The CLI resolves storage profiles. */
export type SnapshotLocation = string;
export interface SnapshotOptions {
  endpoint?: string;
  config?: string;
  omitUnsupportedMounts?: boolean;
}
export interface RestoreOptions extends UpOptions {
  name: string;
  endpoint?: string;
  omitUnsupportedMounts?: boolean;
}
export interface ForkOptions {
  worktree?: string;
  branch?: string;
  ref?: string;
  omitUnsupportedMounts?: boolean;
}

export interface ServiceSummary {
  internal: boolean;
  port?: number;
  protocol?: 'http' | 'tcp';
  httpsUrl?: string;
  url: string | null;
  selected: boolean;
}
export interface InstanceSummary {
  name: string;
  provider: Provider;
  host: string;
  running: boolean;
  connected: boolean;
  /** An interrupted startup needs explicit resume or removal. */
  recovery?: 'required';
  commands: string[];
  environment?: string;
  /** local files, manual, watching, or the current synchronization error. */
  sync: string;
  worktree?: string;
  cloud?: { serverId: number | null; expiresAt: string | null; sleeping: boolean };
  error?: string;
  services: Record<string, ServiceSummary>;
}
export interface ListedInstance extends InstanceSummary { status: Record<string, string> }
export interface MessageResult { message: string }
/** The provider returns combined output. Successful results contain no exit code or separate streams. */
export interface OutputResult { output: string }
export interface OmittedMount { service: string; target: string; type: string; reason: string }
export interface StorageProfileReference { name: string; source: 'user' | 'project' }
export interface SnapshotResult extends MessageResult {
  location: string;
  omittedMounts: OmittedMount[];
  storageProfile?: StorageProfileReference;
}
export interface RestoreResult extends InstanceSummary {
  omittedMounts: OmittedMount[];
  storageProfile?: StorageProfileReference;
}
export interface ForkResult extends InstanceSummary { omittedPaths?: string[] }

export interface Client {
  up(options?: UpOptions): Promise<InstanceSummary>;
  resume(name: string, options?: ResumeOptions): Promise<InstanceSummary>;
  list(): Promise<ListedInstance[]>;
  down(name: string): Promise<MessageResult>;
  remove(name: string, options?: RemoveOptions): Promise<MessageResult>;
  exec(name: string, argv: readonly string[], options?: ServiceOptions): Promise<OutputResult>;
  run(name: string, commandName: string, args?: readonly string[], options?: ServiceOptions): Promise<OutputResult>;
  logs(name: string, options?: ServiceOptions): Promise<OutputResult>;
  sync(name: string): Promise<MessageResult>;
  snapshot(name: string, location: SnapshotLocation, options?: SnapshotOptions): Promise<SnapshotResult>;
  restore(location: SnapshotLocation, options: RestoreOptions): Promise<RestoreResult>;
  fork(source: string, destination: string, options?: ForkOptions): Promise<ForkResult>;
  stopDaemon(): Promise<MessageResult>;
}

export function createClient(options: ClientOptions): Client;
