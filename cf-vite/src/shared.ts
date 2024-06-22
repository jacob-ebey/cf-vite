export const RUNNER_INIT_PATH = "/__viteInit";

export type RunnerEnv = {
  VITE_ENVIRONMENT: string;
  VITE_FETCH_MODULE: Fetcher;
  VITE_ROOT: string;
  VITE_UNSAFE_EVAL: { eval: (code: string, id: string) => any };
};

export type RunnerFetchMetadata = { entry: string };
