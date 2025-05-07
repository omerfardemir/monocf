export interface CfEnv {
  
}

export interface ServerService {
  sum(a: number, b: number): Promise<number>;
}

export interface ThirdServerService {
  sum(a: number, b: number): Promise<number>;
}