export {
  openAICompatibleCompletion,
  openAICompatibleEmbeddings,
  type OpenAICompatibleOptions,
  type OpenAICompletionOptions,
  type OpenAIEmbeddingOptions,
} from './openai';
export { ollamaCompletion, ollamaEmbeddings, type OllamaEmbeddingOptions, type OllamaOptions } from './ollama';
export { voyageEmbeddings, type VoyageEmbeddingOptions } from './voyage';
export {
  providersFromEnv,
  PROVIDER_ENV_VARS,
  type CompletionProviderKind,
  type ConfiguredProviders,
  type EmbeddingProviderKind,
} from './env';
export { KNOWN_DIMENSIONS } from './dimensions';
export type { HttpOptions } from './http';
