/**
 * Snapshot of live GPU object counts owned by a renderer component for M7.8 leak tracking.
 */
export interface GpuResourceCounts {
  readonly programs: number;
  readonly vaos: number;
  readonly buffers: number;
  readonly textures: number;
  readonly framebuffers: number;
  readonly renderbuffers: number;
}

export const EMPTY_GPU_RESOURCE_COUNTS: GpuResourceCounts = Object.freeze({
  programs: 0,
  vaos: 0,
  buffers: 0,
  textures: 0,
  framebuffers: 0,
  renderbuffers: 0,
});

/**
 * Sums multiple `GpuResourceCounts` snapshots into a single aggregate count.
 */
export function addResourceCounts(...counts: readonly GpuResourceCounts[]): GpuResourceCounts {
  let programs = 0;
  let vaos = 0;
  let buffers = 0;
  let textures = 0;
  let framebuffers = 0;
  let renderbuffers = 0;

  for (const item of counts) {
    programs += item.programs;
    vaos += item.vaos;
    buffers += item.buffers;
    textures += item.textures;
    framebuffers += item.framebuffers;
    renderbuffers += item.renderbuffers;
  }

  return {
    programs,
    vaos,
    buffers,
    textures,
    framebuffers,
    renderbuffers,
  };
}
