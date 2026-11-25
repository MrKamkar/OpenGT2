export interface SelectedFileMeta {
  readonly name: string;
  readonly size: number;
  readonly fingerprint?: string;
}

export interface NoFileAppState {
  readonly kind: 'NoFile';
}

export interface LoadingAppState {
  readonly kind: 'Loading';
  readonly file: SelectedFileMeta;
}

export interface ReadyAppState {
  readonly kind: 'Ready';
  readonly file: SelectedFileMeta;
}

export interface ErrorAppState {
  readonly kind: 'Error';
  readonly message: string;
  readonly file?: SelectedFileMeta;
}

export type AppState = NoFileAppState | LoadingAppState | ReadyAppState | ErrorAppState;

export type AppStateKind = AppState['kind'];

export type AppEvent =
  | { readonly type: 'FILE_SELECTED'; readonly file: SelectedFileMeta }
  | { readonly type: 'LOAD_SUCCEEDED'; readonly fingerprint?: string }
  | { readonly type: 'LOAD_FAILED'; readonly message: string }
  | { readonly type: 'FAIL'; readonly message: string; readonly file?: SelectedFileMeta }
  | { readonly type: 'RESET' };

export class InvalidAppStateTransitionError extends Error {
  public readonly fromState: AppStateKind;
  public readonly eventType: AppEvent['type'];

  public constructor(fromState: AppStateKind, eventType: AppEvent['type']) {
    super(`Invalid app state transition: cannot apply "${eventType}" from state "${fromState}".`);
    this.name = 'InvalidAppStateTransitionError';
    this.fromState = fromState;
    this.eventType = eventType;
  }
}

export const INITIAL_APP_STATE: NoFileAppState = Object.freeze({
  kind: 'NoFile',
});

function createErrorState(message: string, file?: SelectedFileMeta): ErrorAppState {
  if (file !== undefined) {
    return { kind: 'Error', message, file };
  }
  return { kind: 'Error', message };
}

export function transitionAppState(state: AppState, event: AppEvent): AppState {
  switch (state.kind) {
    case 'NoFile': {
      switch (event.type) {
        case 'FILE_SELECTED':
          return { kind: 'Loading', file: event.file };
        case 'FAIL':
          return createErrorState(event.message, event.file);
        case 'RESET':
          return INITIAL_APP_STATE;
        case 'LOAD_SUCCEEDED':
        case 'LOAD_FAILED':
          throw new InvalidAppStateTransitionError(state.kind, event.type);
      }
      break;
    }

    case 'Loading': {
      switch (event.type) {
        case 'LOAD_SUCCEEDED': {
          const file: SelectedFileMeta =
            event.fingerprint !== undefined
              ? { ...state.file, fingerprint: event.fingerprint }
              : state.file;
          return { kind: 'Ready', file };
        }
        case 'LOAD_FAILED':
          return createErrorState(event.message, state.file);
        case 'FAIL':
          return createErrorState(event.message, event.file ?? state.file);
        case 'RESET':
          return INITIAL_APP_STATE;
        case 'FILE_SELECTED':
          throw new InvalidAppStateTransitionError(state.kind, event.type);
      }
      break;
    }

    case 'Ready': {
      switch (event.type) {
        case 'FILE_SELECTED':
          return { kind: 'Loading', file: event.file };
        case 'FAIL':
          return createErrorState(event.message, event.file ?? state.file);
        case 'RESET':
          return INITIAL_APP_STATE;
        case 'LOAD_SUCCEEDED':
        case 'LOAD_FAILED':
          throw new InvalidAppStateTransitionError(state.kind, event.type);
      }
      break;
    }

    case 'Error': {
      switch (event.type) {
        case 'FILE_SELECTED':
          return { kind: 'Loading', file: event.file };
        case 'FAIL':
          return createErrorState(event.message, event.file ?? state.file);
        case 'RESET':
          return INITIAL_APP_STATE;
        case 'LOAD_SUCCEEDED':
        case 'LOAD_FAILED':
          throw new InvalidAppStateTransitionError(state.kind, event.type);
      }
      break;
    }
  }
}

export type AppStateListener = (state: AppState) => void;

export class AppStateMachine {
  private state: AppState;
  private readonly listeners = new Set<AppStateListener>();

  public constructor(initialState: AppState = INITIAL_APP_STATE) {
    this.state = initialState;
  }

  public getState(): AppState {
    return this.state;
  }

  public dispatch(event: AppEvent): AppState {
    const nextState = transitionAppState(this.state, event);
    if (nextState !== this.state) {
      this.state = nextState;
      for (const listener of this.listeners) {
        listener(this.state);
      }
    }
    return this.state;
  }

  public subscribe(listener: AppStateListener): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }
}
