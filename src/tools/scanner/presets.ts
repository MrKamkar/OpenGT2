export interface SignaturePreset {
  readonly id: 'gzip' | 'tim' | 'gtfs';
  readonly label: string;
  readonly pattern: string;
  readonly evidence: 'E3' | 'E2';
  readonly description: string;
}

export const SIGNATURE_PRESETS: readonly SignaturePreset[] = [
  {
    id: 'gzip',
    label: 'gzip (1F 8B 08)',
    pattern: '1F 8B 08',
    evidence: 'E3',
    description: 'RFC 1952 gzip stream header (deflate method)',
  },
  {
    id: 'tim',
    label: 'TIM (10 00 00 00)',
    pattern: '10 00 00 00',
    evidence: 'E2',
    description: 'Standard PS1 TIM image header (PSX-SPX)',
  },
  {
    id: 'gtfs',
    label: 'GTFS (GT2.VOL)',
    pattern: '47 54 46 53 00 00 00 00',
    evidence: 'E3',
    description: 'GT2.VOL archive header ("GTFS\\0\\0\\0\\0")',
  },
];
