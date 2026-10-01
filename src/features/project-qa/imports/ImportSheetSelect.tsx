import { SelectField } from '@/components/ui/Field';

interface ImportSheetSelectProps {
  sheetNames: string[];
  value: string;
  onChange: (sheetName: string) => void;
}

/** XLSX에 보이는 시트가 둘 이상일 때만 나온다. 시트 순서는 워크북 그대로이고, 사용자가 고르기 전에는 다음 단계로 갈 수 없다. */
export function ImportSheetSelect({ sheetNames, value, onChange }: ImportSheetSelectProps) {
  if (sheetNames.length < 2) return null;
  return (
    <SelectField label="시트" hint="시트가 여러 개예요. 가져올 시트를 선택하세요." value={value} onChange={(event) => onChange(event.target.value)}>
      <option value="">시트를 선택하세요</option>
      {sheetNames.map((name) => (
        <option key={name} value={name}>
          {name}
        </option>
      ))}
    </SelectField>
  );
}
