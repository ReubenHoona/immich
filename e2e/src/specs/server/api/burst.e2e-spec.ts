import { getConfig, LoginResponseDto, QueueCommand, QueueName, updateConfig } from '@immich/sdk';
import { createUserDto, uuidDto } from 'src/fixtures';
import { app, asBearerAuth, utils } from 'src/utils';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

/**
 * The e2e stack runs with `IMMICH_MACHINE_LEARNING_ENABLED: 'false'`, so grouping itself — which
 * gates on CLIP embedding distance — can never fire here. This spec covers the API contract and
 * the disabled path; the grouping logic is covered by `burst.service.spec.ts` and by a live run
 * against a CLIP-enabled instance.
 */
/** burst group ids are uuid v7, so a v4 fixture would be rejected as malformed rather than missing */
const missingV7 = '019ff3d9-0000-7000-8000-000000000000';

describe('/burst-groups', () => {
  let admin: LoginResponseDto;
  let user1: LoginResponseDto;

  beforeAll(async () => {
    await utils.resetDatabase();
    admin = await utils.adminSetup();
    user1 = await utils.userSetup(admin.accessToken, createUserDto.user1);
  });

  afterAll(async () => {
    await utils.resetAdminConfig(admin.accessToken);
  });

  it('is disabled by default', async () => {
    const config = await getConfig({ headers: asBearerAuth(admin.accessToken) });
    expect(config.machineLearning.burstDetection).toEqual({
      enabled: false,
      timeWindowSeconds: 2,
      maxDistance: 0.12,
      minAssets: 3,
    });
  });

  describe('GET /burst-groups', () => {
    it('should require authentication', async () => {
      const { status } = await request(app).get('/burst-groups');
      expect(status).toBe(401);
    });

    it('should return an empty list for a fresh user', async () => {
      const { status, body } = await request(app)
        .get('/burst-groups')
        .set('Authorization', `Bearer ${user1.accessToken}`);

      expect(status).toBe(200);
      expect(body).toEqual([]);
    });

    it('should reject an invalid status filter', async () => {
      const { status } = await request(app)
        .get('/burst-groups?status=nonsense')
        .set('Authorization', `Bearer ${user1.accessToken}`);

      expect(status).toBe(400);
    });
  });

  describe('GET /burst-groups/:id', () => {
    it('should require authentication', async () => {
      const { status } = await request(app).get(`/burst-groups/${missingV7}`);
      expect(status).toBe(401);
    });

    it('should reject a malformed id', async () => {
      const { status } = await request(app)
        .get('/burst-groups/not-a-uuid')
        .set('Authorization', `Bearer ${user1.accessToken}`);

      expect(status).toBe(400);
    });

    it('should reject a v4 uuid, since group ids are v7', async () => {
      const { status } = await request(app)
        .get(`/burst-groups/${uuidDto.notFound}`)
        .set('Authorization', `Bearer ${user1.accessToken}`);

      expect(status).toBe(400);
    });

    it('should not leak the existence of a group the user cannot see', async () => {
      const { status } = await request(app)
        .get(`/burst-groups/${missingV7}`)
        .set('Authorization', `Bearer ${user1.accessToken}`);

      expect(status).toBe(400);
    });
  });

  describe('POST /burst-groups/:id/accept', () => {
    it('should require authentication', async () => {
      const { status } = await request(app).post(`/burst-groups/${missingV7}/accept`);
      expect(status).toBe(401);
    });
  });

  describe('POST /burst-groups/:id/dismiss', () => {
    it('should require authentication', async () => {
      const { status } = await request(app).post(`/burst-groups/${missingV7}/dismiss`);
      expect(status).toBe(401);
    });
  });

  describe('detection job', () => {
    it('produces nothing while machine learning is unavailable', async () => {
      const config = await getConfig({ headers: asBearerAuth(admin.accessToken) });
      await updateConfig(
        {
          systemConfigDto: {
            ...config,
            machineLearning: {
              ...config.machineLearning,
              burstDetection: { ...config.machineLearning.burstDetection, enabled: true },
            },
          },
        },
        { headers: asBearerAuth(admin.accessToken) },
      );

      await utils.queueCommand(admin.accessToken, QueueName.BurstDetection, {
        command: QueueCommand.Start,
        force: false,
      });
      await utils.waitForQueueFinish(admin.accessToken, 'burstDetection');

      const { status, body } = await request(app)
        .get('/burst-groups')
        .set('Authorization', `Bearer ${admin.accessToken}`);

      expect(status).toBe(200);
      expect(body).toEqual([]);
    });
  });
});
