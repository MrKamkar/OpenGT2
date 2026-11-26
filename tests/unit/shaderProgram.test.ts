import { describe, expect, it } from 'vitest';
import {
  ShaderCompileError,
  ShaderProgram,
  type WebGL2ShaderContext,
  addResourceCounts,
  formatShaderSourceWithLineNumbers,
} from '../../src/renderer';

interface MockShader {
  readonly id: number;
  readonly type: number;
  source: string;
}

interface MockProgram {
  readonly id: number;
  readonly shaders: MockShader[];
}

function createMockShaderGl(options: {
  readonly failVertexCompile?: boolean;
  readonly failFragmentCompile?: boolean;
  readonly failLink?: boolean;
  readonly vertexLog?: string;
  readonly fragmentLog?: string;
  readonly linkLog?: string;
  readonly failCreateProgram?: boolean;
} = {}) {
  let nextId = 1;
  const createdShaders: MockShader[] = [];
  const deletedShaders: MockShader[] = [];
  const createdPrograms: MockProgram[] = [];
  const deletedPrograms: MockProgram[] = [];
  const uniformQueryCounts = new Map<string, number>();
  const attribQueryCounts = new Map<string, number>();
  const uniformCalls: Array<{ readonly method: string; readonly args: readonly unknown[] }> = [];
  let activeProgram: WebGLProgram | null = null;

  const uniformLocations = new Map<string, WebGLUniformLocation>([
    ['u_mvp', { loc: 'u_mvp' } as unknown as WebGLUniformLocation],
    ['u_int', { loc: 'u_int' } as unknown as WebGLUniformLocation],
    ['u_uint', { loc: 'u_uint' } as unknown as WebGLUniformLocation],
    ['u_float', { loc: 'u_float' } as unknown as WebGLUniformLocation],
    ['u_vec2', { loc: 'u_vec2' } as unknown as WebGLUniformLocation],
    ['u_ivec2', { loc: 'u_ivec2' } as unknown as WebGLUniformLocation],
    ['u_vec3', { loc: 'u_vec3' } as unknown as WebGLUniformLocation],
    ['u_vec4', { loc: 'u_vec4' } as unknown as WebGLUniformLocation],
  ]);

  const gl: WebGL2ShaderContext = {
    VERTEX_SHADER: 0x8b31,
    FRAGMENT_SHADER: 0x8b30,
    COMPILE_STATUS: 0x8b81,
    LINK_STATUS: 0x8b82,
    createShader(type: number): WebGLShader | null {
      const shader: MockShader = { id: nextId++, type, source: '' };
      createdShaders.push(shader);
      return shader as unknown as WebGLShader;
    },
    deleteShader(shader: WebGLShader | null): void {
      if (shader !== null) {
        deletedShaders.push(shader as unknown as MockShader);
      }
    },
    shaderSource(shader: WebGLShader, source: string): void {
      (shader as unknown as MockShader).source = source;
    },
    compileShader(): void {
      // No-op in mock.
    },
    getShaderParameter(shader: WebGLShader, pname: number): unknown {
      if (pname !== gl.COMPILE_STATUS) {
        return null;
      }
      const mock = shader as unknown as MockShader;
      if (mock.type === gl.VERTEX_SHADER) {
        return options.failVertexCompile !== true;
      }
      return options.failFragmentCompile !== true;
    },
    getShaderInfoLog(shader: WebGLShader): string | null {
      const mock = shader as unknown as MockShader;
      return mock.type === gl.VERTEX_SHADER
        ? (options.vertexLog ?? '')
        : (options.fragmentLog ?? '');
    },
    createProgram(): WebGLProgram | null {
      if (options.failCreateProgram === true) {
        return null;
      }
      const program: MockProgram = { id: nextId++, shaders: [] };
      createdPrograms.push(program);
      return program as unknown as WebGLProgram;
    },
    deleteProgram(program: WebGLProgram | null): void {
      if (program !== null) {
        deletedPrograms.push(program as unknown as MockProgram);
      }
    },
    attachShader(program: WebGLProgram, shader: WebGLShader): void {
      (program as unknown as MockProgram).shaders.push(shader as unknown as MockShader);
    },
    detachShader(program: WebGLProgram, shader: WebGLShader): void {
      const p = program as unknown as MockProgram;
      const idx = p.shaders.indexOf(shader as unknown as MockShader);
      if (idx >= 0) {
        p.shaders.splice(idx, 1);
      }
    },
    linkProgram(): void {
      // No-op in mock.
    },
    getProgramParameter(_program: WebGLProgram, pname: number): unknown {
      if (pname === gl.LINK_STATUS) {
        return options.failLink !== true;
      }
      return null;
    },
    getProgramInfoLog(): string | null {
      return options.linkLog ?? '';
    },
    useProgram(program: WebGLProgram | null): void {
      activeProgram = program;
    },
    getUniformLocation(_program: WebGLProgram, name: string): WebGLUniformLocation | null {
      uniformQueryCounts.set(name, (uniformQueryCounts.get(name) ?? 0) + 1);
      return uniformLocations.get(name) ?? null;
    },
    getAttribLocation(_program: WebGLProgram, name: string): number {
      attribQueryCounts.set(name, (attribQueryCounts.get(name) ?? 0) + 1);
      return name === 'a_position' ? 0 : -1;
    },
    uniform1i(location: WebGLUniformLocation | null, x: number): void {
      uniformCalls.push({ method: 'uniform1i', args: [location, x] });
    },
    uniform1ui(location: WebGLUniformLocation | null, v0: number): void {
      uniformCalls.push({ method: 'uniform1ui', args: [location, v0] });
    },
    uniform1f(location: WebGLUniformLocation | null, x: number): void {
      uniformCalls.push({ method: 'uniform1f', args: [location, x] });
    },
    uniform2f(location: WebGLUniformLocation | null, x: number, y: number): void {
      uniformCalls.push({ method: 'uniform2f', args: [location, x, y] });
    },
    uniform2i(location: WebGLUniformLocation | null, x: number, y: number): void {
      uniformCalls.push({ method: 'uniform2i', args: [location, x, y] });
    },
    uniform3f(location: WebGLUniformLocation | null, x: number, y: number, z: number): void {
      uniformCalls.push({ method: 'uniform3f', args: [location, x, y, z] });
    },
    uniform4f(
      location: WebGLUniformLocation | null,
      x: number,
      y: number,
      z: number,
      w: number,
    ): void {
      uniformCalls.push({ method: 'uniform4f', args: [location, x, y, z, w] });
    },
    uniformMatrix4fv(
      location: WebGLUniformLocation | null,
      transpose: boolean,
      value: Float32List,
    ): void {
      uniformCalls.push({ method: 'uniformMatrix4fv', args: [location, transpose, value] });
    },
  };

  return {
    gl,
    createdShaders,
    deletedShaders,
    createdPrograms,
    deletedPrograms,
    uniformQueryCounts,
    attribQueryCounts,
    uniformCalls,
    getActiveProgram: () => activeProgram,
  };
}

describe('ShaderProgram (M7.1)', () => {
  const VERTEX_SRC = '#version 300 es\nlayout(location = 0) in vec3 a_position;\nvoid main() { gl_Position = vec4(a_position, 1.0); }';
  const FRAGMENT_SRC = '#version 300 es\nprecision mediump float;\nout vec4 fragColor;\nvoid main() { fragColor = vec4(1.0); }';

  it('formats shader source with 1-based line numbers and highlights error lines', () => {
    const formatted = formatShaderSourceWithLineNumbers(
      'line1\nline2\nline3',
      'ERROR: 0:2: syntax error',
    );
    expect(formatted).toContain('  0001: line1');
    expect(formatted).toContain('> 0002: line2');
    expect(formatted).toContain('  0003: line3');
  });

  it('compiles, links, detaches/deletes intermediate shaders, caches uniform & attrib lookups, and disposes idempotently', () => {
    const mock = createMockShaderGl();
    const program = new ShaderProgram(mock.gl, VERTEX_SRC, FRAGMENT_SRC, 'test-shader');

    expect(mock.createdShaders).toHaveLength(2);
    expect(mock.deletedShaders).toHaveLength(2);
    expect(mock.createdPrograms).toHaveLength(1);
    expect(mock.createdPrograms[0]?.shaders).toHaveLength(0);
    expect(program.getResourceCounts().programs).toBe(1);

    program.use();
    expect(mock.getActiveProgram()).toBe(program.program);

    const mat = new Float32Array(16);
    program.setMat4('u_mvp', mat);
    program.setMat4('u_mvp', mat);
    program.setInt('u_int', 2);
    program.setUint('u_uint', 7);
    program.setFloat('u_float', 0.5);
    program.setVec2('u_vec2', 320, 240);
    program.setIVec2('u_ivec2', 256, 224);
    program.setVec3('u_vec3', 1, 2, 3);
    program.setVec4('u_vec4', 1, 2, 3, 4);
    // Missing uniform (optimized out) should be cached as null and not invoke uniform setters.
    program.setFloat('u_missing', 123);
    program.setFloat('u_missing', 456);

    expect(mock.uniformQueryCounts.get('u_mvp')).toBe(1);
    expect(mock.uniformQueryCounts.get('u_missing')).toBe(1);
    expect(mock.uniformCalls).toHaveLength(9);

    expect(program.getAttribLocation('a_position')).toBe(0);
    expect(program.getAttribLocation('a_position')).toBe(0);
    expect(mock.attribQueryCounts.get('a_position')).toBe(1);

    program.dispose();
    program.dispose();
    expect(program.isDisposed()).toBe(true);
    expect(program.getResourceCounts().programs).toBe(0);
    expect(mock.deletedPrograms).toHaveLength(1);
    expect(() => program.use()).toThrow(/disposed/i);
  });

  it('throws ShaderCompileError with line numbers on vertex compile error and cleans up shader', () => {
    const mock = createMockShaderGl({
      failVertexCompile: true,
      vertexLog: "ERROR: 0:2: 'bad_token' : syntax error",
    });

    let caught: unknown = null;
    try {
      new ShaderProgram(mock.gl, VERTEX_SRC, FRAGMENT_SRC, 'car-ps1');
    } catch (err) {
      caught = err;
    }

    expect(caught).toBeInstanceOf(ShaderCompileError);
    const err = caught as ShaderCompileError;
    expect(err.stage).toBe('vertex');
    expect(err.message).toContain('[car-ps1]');
    expect(err.message).toContain('> 0002:');
    expect(mock.deletedShaders).toHaveLength(1);
    expect(mock.createdPrograms).toHaveLength(0);
  });

  it('throws ShaderCompileError on fragment compile error and cleans up both shaders', () => {
    const mock = createMockShaderGl({
      failFragmentCompile: true,
      fragmentLog: 'ERROR: 0:3: undeclared identifier',
    });

    expect(() => new ShaderProgram(mock.gl, VERTEX_SRC, FRAGMENT_SRC)).toThrow(ShaderCompileError);
    expect(mock.createdShaders).toHaveLength(2);
    expect(mock.deletedShaders).toHaveLength(2);
    expect(mock.createdPrograms).toHaveLength(0);
  });

  it('throws ShaderCompileError on link error and deletes partial program and shaders', () => {
    const mock = createMockShaderGl({
      failLink: true,
      linkLog: 'Varying type mismatch',
    });

    let caught: unknown = null;
    try {
      new ShaderProgram(mock.gl, VERTEX_SRC, FRAGMENT_SRC, 'link-test');
    } catch (err) {
      caught = err;
    }

    expect(caught).toBeInstanceOf(ShaderCompileError);
    expect((caught as ShaderCompileError).stage).toBe('link');
    expect(mock.deletedShaders).toHaveLength(2);
    expect(mock.deletedPrograms).toHaveLength(1);
  });

  it('sums GPU resource counts cleanly', () => {
    const total = addResourceCounts(
      { programs: 1, vaos: 1, buffers: 3, textures: 2, framebuffers: 0, renderbuffers: 0 },
      { programs: 2, vaos: 0, buffers: 1, textures: 1, framebuffers: 2, renderbuffers: 2 },
    );
    expect(total).toEqual({
      programs: 3,
      vaos: 1,
      buffers: 4,
      textures: 3,
      framebuffers: 2,
      renderbuffers: 2,
    });
  });
});
