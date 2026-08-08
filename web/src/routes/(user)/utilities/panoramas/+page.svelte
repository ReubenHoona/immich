<script lang="ts">
  import UserPageLayout from '$lib/components/layouts/UserPageLayout.svelte';
  import { getAssetMediaUrl } from '$lib/utils';
  import { handleError } from '$lib/utils/handle-error';
  import {
    PanoramaGroupStatus,
    PanoramaGroupUpdateStatus,
    previewPanorama,
    stitchPanorama,
    updatePanorama,
    type PanoramaGroupResponseDto,
  } from '@immich/sdk';
  import { Button, Icon, Text } from '@immich/ui';
  import { mdiClose, mdiEyeOutline, mdiImageMultipleOutline, mdiPanorama } from '@mdi/js';
  import { t } from 'svelte-i18n';
  import type { PageData } from './$types';

  interface Props {
    data: PageData;
  }

  let { data }: Props = $props();

  let groups = $state<PanoramaGroupResponseDto[]>(data.panoramas);
  let previewUrl = $state<string | null>(null);
  let previewLoading = $state<string | null>(null);
  let stitching = $state(new Set<string>());

  const candidates = $derived(groups.filter((group) => group.status === PanoramaGroupStatus.Candidate));
  const others = $derived(groups.filter((group) => group.status !== PanoramaGroupStatus.Candidate));

  const groupDate = (group: PanoramaGroupResponseDto) => {
    const iso = group.assets[0]?.exifInfo?.dateTimeOriginal ?? group.assets[0]?.fileCreatedAt;
    return iso ? new Date(iso).toLocaleString() : '';
  };

  const onPreview = async (group: PanoramaGroupResponseDto) => {
    if (previewLoading) {
      return;
    }
    previewLoading = group.id;
    try {
      const blob = await previewPanorama({ id: group.id });
      previewUrl = URL.createObjectURL(blob);
    } catch (error) {
      handleError(error, $t('panorama_preview_failed'));
    } finally {
      previewLoading = null;
    }
  };

  const closePreview = () => {
    if (previewUrl) {
      URL.revokeObjectURL(previewUrl);
      previewUrl = null;
    }
  };

  const onGenerate = async (group: PanoramaGroupResponseDto) => {
    try {
      await stitchPanorama({ id: group.id });
      stitching = new Set([...stitching, group.id]);
    } catch (error) {
      handleError(error, $t('panorama_generate_failed'));
    }
  };

  const onSetStatus = async (group: PanoramaGroupResponseDto, status: PanoramaGroupUpdateStatus) => {
    try {
      const updated = await updatePanorama({ id: group.id, panoramaGroupUpdateDto: { status } });
      groups = groups.map((candidate) => (candidate.id === group.id ? updated : candidate));
    } catch (error) {
      handleError(error, $t('panorama_update_failed'));
    }
  };
</script>

<UserPageLayout title={data.meta.title}>
  <div class="mx-4 flex flex-col gap-6">
    {#if groups.length === 0}
      <div class="flex flex-col items-center gap-2 p-16 text-center">
        <Icon icon={mdiPanorama} size="48" class="text-primary" />
        <Text>{$t('panoramas_empty')}</Text>
      </div>
    {/if}

    {#each [...candidates, ...others] as group (group.id)}
      <div class="rounded-2xl border border-gray-300 p-4 dark:border-immich-dark-gray">
        <div class="mb-3 flex flex-wrap items-center gap-3">
          <Icon icon={mdiImageMultipleOutline} size="20" class="text-primary" />
          <Text fontWeight="medium">{groupDate(group)}</Text>
          <Text size="small" color="muted">
            {$t('panorama_frames_score', { values: { frames: group.assets.length, score: group.score.toFixed(1) } })}
          </Text>
          <span
            class="rounded-full px-3 py-0.5 text-xs {group.status === PanoramaGroupStatus.Completed
              ? 'bg-green-100 text-green-900 dark:bg-green-900 dark:text-green-100'
              : group.status === PanoramaGroupStatus.Failed
                ? 'bg-red-100 text-red-900 dark:bg-red-900 dark:text-red-100'
                : 'bg-gray-100 text-gray-900 dark:bg-immich-dark-gray dark:text-gray-100'}"
          >
            {group.status}
          </span>
        </div>

        <div class="flex gap-1 overflow-x-auto pb-2">
          {#each group.assets as asset (asset.id)}
            <img
              src={getAssetMediaUrl({ id: asset.id, cacheKey: asset.thumbhash })}
              alt={asset.originalFileName}
              title={asset.originalFileName}
              class="h-28 rounded-lg object-cover"
              loading="lazy"
            />
          {/each}
        </div>

        <div class="mt-3 flex flex-wrap gap-2">
          {#if group.status === PanoramaGroupStatus.Candidate || group.status === PanoramaGroupStatus.Failed}
            <Button
              size="small"
              shape="round"
              variant="outline"
              leadingIcon={mdiEyeOutline}
              loading={previewLoading === group.id}
              onclick={() => onPreview(group)}
            >
              {$t('panorama_preview')}
            </Button>
            <Button
              size="small"
              shape="round"
              disabled={stitching.has(group.id)}
              onclick={() => onGenerate(group)}
            >
              {stitching.has(group.id) ? $t('panorama_generating') : $t('panorama_generate')}
            </Button>
            <Button
              size="small"
              shape="round"
              color="secondary"
              variant="ghost"
              onclick={() => onSetStatus(group, PanoramaGroupUpdateStatus.Dismissed)}
            >
              {$t('dismiss')}
            </Button>
          {:else if group.status === PanoramaGroupStatus.Dismissed}
            <Button
              size="small"
              shape="round"
              variant="outline"
              onclick={() => onSetStatus(group, PanoramaGroupUpdateStatus.Candidate)}
            >
              {$t('panorama_restore')}
            </Button>
          {:else if group.status === PanoramaGroupStatus.Completed && group.resultAssetId}
            <Button size="small" shape="round" href="/photos/{group.resultAssetId}">
              {$t('panorama_view_result')}
            </Button>
          {/if}
        </div>
      </div>
    {/each}
  </div>
</UserPageLayout>

{#if previewUrl}
  <div
    class="fixed inset-0 z-50 flex items-center justify-center bg-black/80 p-6"
    role="button"
    tabindex="0"
    onclick={closePreview}
    onkeydown={(event) => event.key === 'Escape' && closePreview()}
  >
    <img src={previewUrl} alt={$t('panorama_preview')} class="max-h-full max-w-full rounded-lg shadow-2xl" />
    <button type="button" class="absolute top-4 end-4 text-white" onclick={closePreview} aria-label={$t('close')}>
      <Icon icon={mdiClose} size="32" />
    </button>
  </div>
{/if}
