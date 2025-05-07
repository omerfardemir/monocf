import {WorkerCommand} from '../types/command-types.js'

export interface WorkerArgs {
  workerName?: string
}

export interface WorkerFlags {
  all?: boolean
  baseConfig?: string
  command: WorkerCommand
  deploySecrets?: boolean
  env?: string
  rootDir?: string
  workersDirName?: string
}

export interface CreateWorkerArgs {
  workerName: string
}

export interface CreateWorkerFlags {
  rootDir?: string
  workersDirName?: string
}

// Utility type to extract the type of a field from an interface
type ExtractFieldType<T, K extends keyof T> = T[K]

// Utility type to verify bidirectional compatibility between F and T
// This will cause a compile-time error if:
// 1. A property is added to T that's not in F
// 2. A property is added to F that's not in T
// The error message will include the expected type of the missing field
export type VerifiedFields<T, F extends Record<string, unknown>> = keyof F extends keyof T
  ? keyof T extends keyof F
    ? F
    : {[K in Exclude<keyof T, keyof F>]: ExtractFieldType<T, K>} & F
  : {[K in Exclude<keyof F, keyof T>]: never} & F
