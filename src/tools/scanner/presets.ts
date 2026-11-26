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
    description: 'Nagłówek strumienia gzip RFC 1952 (metoda deflate)',
  },
  {
    id: 'tim',
    label: 'TIM (10 00 00 00)',
    pattern: '10 00 00 00',
    evidence: 'E2',
    description: 'Standardowy nagłówek obrazu PS1 TIM (PSX-SPX)',
  },
  {
    id: 'gtfs',
    label: 'GTFS (GT2.VOL)',
    pattern: '47 54 46 53 00 00 00 00',
    evidence: 'E3',
    description: 'Nagłówek archiwum GT2.VOL ("GTFS\\0\\0\\0\\0")',
  },
];
