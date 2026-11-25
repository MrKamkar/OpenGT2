import { describe, expect, it, vi } from 'vitest';
import {
  AppStateMachine,
  INITIAL_APP_STATE,
  InvalidAppStateTransitionError,
  transitionAppState,
  type AppState,
  type SelectedFileMeta,
} from '../../src/app/appState';

const SAMPLE_FILE: SelectedFileMeta = {
  name: 'GT2.VOL',
  size: 1_572_864,
};

const SECOND_FILE: SelectedFileMeta = {
  name: 'GT2_DISC2.VOL',
  size: 524_288_000,
};

describe('AppStateMachine (M0.5)', () => {
  it('starts in NoFile state', () => {
    const machine = new AppStateMachine();
    expect(machine.getState()).toEqual({ kind: 'NoFile' });
    expect(machine.getState()).toBe(INITIAL_APP_STATE);
  });

  it('transitions along happy path NoFile -> Loading -> Ready', () => {
    const loading = transitionAppState(INITIAL_APP_STATE, {
      type: 'FILE_SELECTED',
      file: SAMPLE_FILE,
    });
    expect(loading).toEqual({ kind: 'Loading', file: SAMPLE_FILE });

    const ready = transitionAppState(loading, { type: 'LOAD_SUCCEEDED' });
    expect(ready).toEqual({ kind: 'Ready', file: SAMPLE_FILE });
  });

  it('transitions along error path NoFile -> Loading -> Error and allows recovery', () => {
    const loading = transitionAppState(INITIAL_APP_STATE, {
      type: 'FILE_SELECTED',
      file: SAMPLE_FILE,
    });
    const errored = transitionAppState(loading, {
      type: 'LOAD_FAILED',
      message: 'Unexpected file error',
    });
    expect(errored).toEqual({
      kind: 'Error',
      message: 'Unexpected file error',
      file: SAMPLE_FILE,
    });

    const reset = transitionAppState(errored, { type: 'RESET' });
    expect(reset).toEqual({ kind: 'NoFile' });

    const retry = transitionAppState(errored, {
      type: 'FILE_SELECTED',
      file: SECOND_FILE,
    });
    expect(retry).toEqual({ kind: 'Loading', file: SECOND_FILE });
  });

  it('supports FAIL from NoFile, Ready, and Error states', () => {
    const noFileError = transitionAppState(INITIAL_APP_STATE, {
      type: 'FAIL',
      message: 'WebGL2 unavailable',
    });
    expect(noFileError).toEqual({
      kind: 'Error',
      message: 'WebGL2 unavailable',
    });
    expect('file' in noFileError).toBe(false);

    const ready: AppState = { kind: 'Ready', file: SAMPLE_FILE };
    const readyError = transitionAppState(ready, {
      type: 'FAIL',
      message: 'Context lost permanently',
    });
    expect(readyError).toEqual({
      kind: 'Error',
      message: 'Context lost permanently',
      file: SAMPLE_FILE,
    });

    const reloaded = transitionAppState(ready, {
      type: 'FILE_SELECTED',
      file: SECOND_FILE,
    });
    expect(reloaded).toEqual({ kind: 'Loading', file: SECOND_FILE });
  });

  it('rejects invalid state transitions with InvalidAppStateTransitionError', () => {
    expect(() =>
      transitionAppState(INITIAL_APP_STATE, { type: 'LOAD_SUCCEEDED' }),
    ).toThrow(InvalidAppStateTransitionError);

    expect(() =>
      transitionAppState(INITIAL_APP_STATE, {
        type: 'LOAD_FAILED',
        message: 'not loading',
      }),
    ).toThrow(InvalidAppStateTransitionError);

    const loading: AppState = { kind: 'Loading', file: SAMPLE_FILE };
    expect(() =>
      transitionAppState(loading, { type: 'FILE_SELECTED', file: SECOND_FILE }),
    ).toThrow(InvalidAppStateTransitionError);

    const ready: AppState = { kind: 'Ready', file: SAMPLE_FILE };
    expect(() => transitionAppState(ready, { type: 'LOAD_SUCCEEDED' })).toThrow(
      InvalidAppStateTransitionError,
    );

    const errored: AppState = { kind: 'Error', message: 'boom' };
    expect(() => transitionAppState(errored, { type: 'LOAD_SUCCEEDED' })).toThrow(
      InvalidAppStateTransitionError,
    );
  });

  it('notifies listeners on state change and stops after unsubscribe', () => {
    const machine = new AppStateMachine();
    const observed: AppState['kind'][] = [];
    const listener = vi.fn((next: AppState) => {
      observed.push(next.kind);
    });

    const unsubscribe = machine.subscribe(listener);

    machine.dispatch({ type: 'RESET' });
    expect(listener).not.toHaveBeenCalled();

    machine.dispatch({ type: 'FILE_SELECTED', file: SAMPLE_FILE });
    machine.dispatch({ type: 'LOAD_SUCCEEDED' });

    unsubscribe();

    machine.dispatch({ type: 'RESET' });

    expect(observed).toEqual(['Loading', 'Ready']);
    expect(machine.getState()).toEqual({ kind: 'NoFile' });
  });
});
