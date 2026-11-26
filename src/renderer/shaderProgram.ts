import type { GpuResourceCounts } from './types';

export type ShaderFailureStage = 'vertex' | 'fragment' | 'link';

/**
 * Minimal WebGL2 shader/program subset so `ShaderProgram` works with both a real
 * `WebGL2RenderingContext` and lightweight Node test mocks.
 */
export interface WebGL2ShaderContext {
  readonly VERTEX_SHADER: number;
  readonly FRAGMENT_SHADER: number;
  readonly COMPILE_STATUS: number;
  readonly LINK_STATUS: number;
  createShader(type: number): WebGLShader | null;
  deleteShader(shader: WebGLShader | null): void;
  shaderSource(shader: WebGLShader, source: string): void;
  compileShader(shader: WebGLShader): void;
  getShaderParameter(shader: WebGLShader, pname: number): unknown;
  getShaderInfoLog(shader: WebGLShader): string | null;
  createProgram(): WebGLProgram | null;
  deleteProgram(program: WebGLProgram | null): void;
  attachShader(program: WebGLProgram, shader: WebGLShader): void;
  detachShader?(program: WebGLProgram, shader: WebGLShader): void;
  linkProgram(program: WebGLProgram): void;
  getProgramParameter(program: WebGLProgram, pname: number): unknown;
  getProgramInfoLog(program: WebGLProgram): string | null;
  useProgram(program: WebGLProgram | null): void;
  getUniformLocation(program: WebGLProgram, name: string): WebGLUniformLocation | null;
  getAttribLocation(program: WebGLProgram, name: string): number;
  uniform1i(location: WebGLUniformLocation | null, x: number): void;
  uniform1ui(location: WebGLUniformLocation | null, v0: number): void;
  uniform1f(location: WebGLUniformLocation | null, x: number): void;
  uniform2f(location: WebGLUniformLocation | null, x: number, y: number): void;
  uniform2i(location: WebGLUniformLocation | null, x: number, y: number): void;
  uniform3f(location: WebGLUniformLocation | null, x: number, y: number, z: number): void;
  uniform4f(
    location: WebGLUniformLocation | null,
    x: number,
    y: number,
    z: number,
    w: number,
  ): void;
  uniformMatrix4fv(
    location: WebGLUniformLocation | null,
    transpose: boolean,
    value: Float32List,
  ): void;
}

const GLSL_ERROR_LINE_PATTERN = /\b(?:ERROR|WARNING):\s*\d+:(\d+)\b/g;

function extractReportedLines(infoLog: string): ReadonlySet<number> {
  const lines = new Set<number>();
  GLSL_ERROR_LINE_PATTERN.lastIndex = 0;
  let match = GLSL_ERROR_LINE_PATTERN.exec(infoLog);
  while (match !== null) {
    const parsed = Number.parseInt(match[1] ?? '', 10);
    if (Number.isInteger(parsed) && parsed > 0) {
      lines.add(parsed);
    }
    match = GLSL_ERROR_LINE_PATTERN.exec(infoLog);
  }
  return lines;
}

/**
 * Formats GLSL source code with 1-based padded line numbers and highlights lines
 * referenced in an optional GLSL compiler/linker info log.
 */
export function formatShaderSourceWithLineNumbers(source: string, infoLog = ''): string {
  const rawLines = source.replace(/\r\n/g, '\n').split('\n');
  const width = Math.max(4, String(rawLines.length).length);
  const flaggedLines = extractReportedLines(infoLog);

  return rawLines
    .map((line, index) => {
      const lineNumber = index + 1;
      const prefix = flaggedLines.has(lineNumber) ? '>' : ' ';
      const padded = String(lineNumber).padStart(width, '0');
      return `${prefix} ${padded}: ${line}`;
    })
    .join('\n');
}

/**
 * Error thrown when GLSL ES 3.00 shader compilation or program linking fails.
 */
export class ShaderCompileError extends Error {
  public readonly stage: ShaderFailureStage;
  public readonly infoLog: string;
  public readonly formattedSource: string;
  public readonly label: string | undefined;

  public constructor(
    stage: ShaderFailureStage,
    infoLog: string,
    formattedSource: string,
    label?: string,
  ) {
    const trimmedLog = infoLog.trim() || '(no driver info log)';
    const labelSuffix = label !== undefined && label.length > 0 ? ` [${label}]` : '';
    const sourceSection = formattedSource.length > 0 ? `\n${formattedSource}` : '';
    super(`GLSL ${stage} failure${labelSuffix}: ${trimmedLog}${sourceSection}`);
    this.name = 'ShaderCompileError';
    this.stage = stage;
    this.infoLog = trimmedLog;
    this.formattedSource = formattedSource;
    this.label = label;
  }
}

function compileSingleShader(
  gl: WebGL2ShaderContext,
  stage: 'vertex' | 'fragment',
  shaderType: number,
  source: string,
  label: string | undefined,
): WebGLShader {
  const shader = gl.createShader(shaderType);
  if (shader === null) {
    throw new ShaderCompileError(
      stage,
      `gl.createShader returned null for ${stage} shader.`,
      formatShaderSourceWithLineNumbers(source),
      label,
    );
  }

  gl.shaderSource(shader, source);
  gl.compileShader(shader);

  if (gl.getShaderParameter(shader, gl.COMPILE_STATUS) !== true) {
    const infoLog = gl.getShaderInfoLog(shader) ?? '';
    gl.deleteShader(shader);
    throw new ShaderCompileError(
      stage,
      infoLog,
      formatShaderSourceWithLineNumbers(source, infoLog),
      label,
    );
  }

  return shader;
}

/**
 * Pure WebGL2 GLSL ES 3.00 shader program wrapper with uniform/attribute location caching,
 * line-numbered compilation diagnostics, and idempotent `dispose()`.
 */
export class ShaderProgram {
  public readonly program: WebGLProgram;
  public readonly label: string | undefined;

  private readonly gl: WebGL2ShaderContext;
  private readonly uniformCache = new Map<string, WebGLUniformLocation | null>();
  private readonly attribCache = new Map<string, number>();
  private disposed = false;

  public constructor(
    gl: WebGL2ShaderContext,
    vertexSource: string,
    fragmentSource: string,
    label?: string,
  ) {
    this.gl = gl;
    this.label = label;

    const vertexShader = compileSingleShader(
      gl,
      'vertex',
      gl.VERTEX_SHADER,
      vertexSource,
      label,
    );

    let fragmentShader: WebGLShader | null = null;
    let program: WebGLProgram | null = null;

    try {
      fragmentShader = compileSingleShader(
        gl,
        'fragment',
        gl.FRAGMENT_SHADER,
        fragmentSource,
        label,
      );

      program = gl.createProgram();
      if (program === null) {
        throw new ShaderCompileError('link', 'gl.createProgram returned null.', '', label);
      }

      gl.attachShader(program, vertexShader);
      gl.attachShader(program, fragmentShader);
      gl.linkProgram(program);

      if (gl.getProgramParameter(program, gl.LINK_STATUS) !== true) {
        const infoLog = gl.getProgramInfoLog(program) ?? '';
        gl.deleteProgram(program);
        program = null;
        const combinedSource =
          `// --- Vertex Shader ---\n${formatShaderSourceWithLineNumbers(vertexSource)}\n` +
          `// --- Fragment Shader ---\n${formatShaderSourceWithLineNumbers(fragmentSource)}`;
        throw new ShaderCompileError('link', infoLog, combinedSource, label);
      }

      this.program = program;
    } finally {
      if (program !== null && gl.detachShader !== undefined) {
        gl.detachShader(program, vertexShader);
        if (fragmentShader !== null) {
          gl.detachShader(program, fragmentShader);
        }
      }
      gl.deleteShader(vertexShader);
      if (fragmentShader !== null) {
        gl.deleteShader(fragmentShader);
      }
    }
  }

  public isDisposed(): boolean {
    return this.disposed;
  }

  public use(): void {
    if (this.disposed) {
      throw new Error('Cannot use a disposed ShaderProgram.');
    }
    this.gl.useProgram(this.program);
  }

  public getUniformLocation(name: string): WebGLUniformLocation | null {
    if (this.disposed) {
      return null;
    }
    if (this.uniformCache.has(name)) {
      return this.uniformCache.get(name) ?? null;
    }
    const location = this.gl.getUniformLocation(this.program, name);
    this.uniformCache.set(name, location);
    return location;
  }

  public getAttribLocation(name: string): number {
    if (this.disposed) {
      return -1;
    }
    const cached = this.attribCache.get(name);
    if (cached !== undefined) {
      return cached;
    }
    const location = this.gl.getAttribLocation(this.program, name);
    this.attribCache.set(name, location);
    return location;
  }

  public setInt(name: string, value: number): void {
    const loc = this.getUniformLocation(name);
    if (loc !== null) {
      this.gl.uniform1i(loc, value);
    }
  }

  public setUint(name: string, value: number): void {
    const loc = this.getUniformLocation(name);
    if (loc !== null) {
      this.gl.uniform1ui(loc, value >>> 0);
    }
  }

  public setFloat(name: string, value: number): void {
    const loc = this.getUniformLocation(name);
    if (loc !== null) {
      this.gl.uniform1f(loc, value);
    }
  }

  public setVec2(name: string, x: number, y: number): void {
    const loc = this.getUniformLocation(name);
    if (loc !== null) {
      this.gl.uniform2f(loc, x, y);
    }
  }

  public setIVec2(name: string, x: number, y: number): void {
    const loc = this.getUniformLocation(name);
    if (loc !== null) {
      this.gl.uniform2i(loc, x | 0, y | 0);
    }
  }

  public setVec3(name: string, x: number, y: number, z: number): void {
    const loc = this.getUniformLocation(name);
    if (loc !== null) {
      this.gl.uniform3f(loc, x, y, z);
    }
  }

  public setVec4(name: string, x: number, y: number, z: number, w: number): void {
    const loc = this.getUniformLocation(name);
    if (loc !== null) {
      this.gl.uniform4f(loc, x, y, z, w);
    }
  }

  public setMat4(name: string, matrix: Float32List, transpose = false): void {
    const loc = this.getUniformLocation(name);
    if (loc !== null) {
      this.gl.uniformMatrix4fv(loc, transpose, matrix);
    }
  }

  public getResourceCounts(): GpuResourceCounts {
    return {
      programs: this.disposed ? 0 : 1,
      vaos: 0,
      buffers: 0,
      textures: 0,
      framebuffers: 0,
      renderbuffers: 0,
    };
  }

  public dispose(): void {
    if (this.disposed) {
      return;
    }
    this.disposed = true;
    this.uniformCache.clear();
    this.attribCache.clear();
    this.gl.deleteProgram(this.program);
  }
}
