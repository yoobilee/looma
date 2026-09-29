import { PageHeader } from '@/components/layout/PageHeader';
import { ButtonLink } from '@/components/ui/Button';
import { StateMessage } from '@/components/ui/StateMessage';

export function NotFoundPage() {
  return (
    <>
      <PageHeader title="페이지를 찾을 수 없어요" />
      <StateMessage
        title="주소가 바뀌었거나 없는 화면이에요."
        action={
          <ButtonLink to="/today" variant="primary">
            오늘 화면으로
          </ButtonLink>
        }
      />
    </>
  );
}
