<script lang="ts">
  import ImageThumbnail from '$lib/components/assets/thumbnail/ImageThumbnail.svelte';
  import UserPageLayout from '$lib/components/layouts/UserPageLayout.svelte';
  import EmptyPlaceholder from '$lib/components/shared-components/EmptyPlaceholder.svelte';
  import { getAssetMediaUrl } from '$lib/utils';
  import { handleError } from '$lib/utils/handle-error';
  import {
    acceptBurstGroup,
    AssetMediaSize,
    BurstGroupStatus,
    dismissBurstGroup,
    searchBurstGroups,
    type BurstGroupResponseDto,
  } from '@immich/sdk';
  import { Button, HStack, LoadingSpinner, Text, toastManager } from '@immich/ui';
  import { mdiCheckOutline, mdiCloseOutline } from '@mdi/js';
  import { onMount } from 'svelte';
  import { t } from 'svelte-i18n';
  import type { PageData } from './$types';

  type Props = { data: PageData };
  let { data }: Props = $props();

  let groups = $state<BurstGroupResponseDto[]>([]);
  let isLoading = $state(true);
  let busy = $state<{ id: string; action: 'stack' | 'dismiss' } | undefined>();

  const load = async () => {
    try {
      groups = await searchBurstGroups({ status: BurstGroupStatus.Candidate });
    } catch (error) {
      handleError(error, $t('errors.unable_to_load_burst_groups'));
    } finally {
      isLoading = false;
    }
  };

  onMount(load);

  const resolve = async (group: BurstGroupResponseDto, accept: boolean) => {
    busy = { id: group.id, action: accept ? 'stack' : 'dismiss' };
    try {
      await (accept ? acceptBurstGroup({ id: group.id }) : dismissBurstGroup({ id: group.id }));
      groups = groups.filter(({ id }) => id !== group.id);
      toastManager.success(
        accept
          ? $t('burst_stacked', { values: { count: group.assets.length } })
          : $t('burst_dismissed', { values: { count: group.assets.length } }),
      );
    } catch (error) {
      handleError(error, accept ? $t('errors.unable_to_stack_burst') : $t('errors.unable_to_dismiss_burst'));
    } finally {
      busy = undefined;
    }
  };
</script>

<UserPageLayout title={data.meta.title} scrollbar={true}>
  {#if isLoading}
    <div class="flex justify-center p-8"><LoadingSpinner /></div>
  {:else if groups.length === 0}
    <EmptyPlaceholder text={$t('no_bursts_to_review')} class="mx-auto mt-10" />
  {:else}
    <div class="mb-4">
      <Text color="muted">{$t('burst_review_description', { values: { count: groups.length } })}</Text>
    </div>

    <div class="flex flex-col gap-6">
      {#each groups as group (group.id)}
        <section class="rounded-3xl border border-gray-300 p-4 dark:border-immich-dark-gray">
          <HStack class="mb-3 justify-between">
            <Text fontWeight="medium">
              {$t('burst_frame_count', { values: { count: group.assets.length } })}
            </Text>
            <HStack gap={2}>
              <Button
                size="small"
                color="primary"
                leadingIcon={mdiCheckOutline}
                loading={busy?.id === group.id && busy.action === 'stack'}
                disabled={!!busy}
                onclick={() => resolve(group, true)}
              >
                {$t('stack')}
              </Button>
              <Button
                size="small"
                color="secondary"
                leadingIcon={mdiCloseOutline}
                loading={busy?.id === group.id && busy.action === 'dismiss'}
                disabled={!!busy}
                onclick={() => resolve(group, false)}
              >
                {$t('dismiss')}
              </Button>
            </HStack>
          </HStack>

          <div class="flex flex-wrap gap-2">
            {#each group.assets as asset, index (asset.id)}
              <div class="flex flex-col items-center gap-1">
                <!-- ImageThumbnail needs a positioned ancestor: its image is absolutely placed -->
                <div class="relative size-[120px] overflow-hidden rounded-lg">
                  <ImageThumbnail
                    url={getAssetMediaUrl({ id: asset.id, size: AssetMediaSize.Thumbnail, cacheKey: asset.thumbhash })}
                    altText={asset.originalFileName}
                    title={asset.originalFileName}
                    widthStyle="120px"
                    heightStyle="120px"
                    curve={true}
                  />
                </div>
                <Text size="tiny" color="muted">
                  {index === 0 ? $t('burst_reference_frame') : group.distances[index].toFixed(3)}
                </Text>
              </div>
            {/each}
          </div>
        </section>
      {/each}
    </div>
  {/if}
</UserPageLayout>
