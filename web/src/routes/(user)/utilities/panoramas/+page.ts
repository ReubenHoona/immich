import { authenticate } from '$lib/utils/auth';
import { getFormatter } from '$lib/utils/i18n';
import { getPanoramas } from '@immich/sdk';
import type { PageLoad } from './$types';

export const load = (async ({ url }) => {
  await authenticate(url);
  const panoramas = await getPanoramas({});
  const $t = await getFormatter();

  return {
    panoramas,
    meta: {
      title: $t('panoramas'),
    },
  };
}) satisfies PageLoad;
