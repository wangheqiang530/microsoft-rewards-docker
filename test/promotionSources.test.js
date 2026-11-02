import test from 'node:test';
import assert from 'node:assert/strict';
import {
  buildAppActivityPayload,
  extractDailySetCardsFromDashboard,
  getAppCheckInStatusFromPromotions,
  getPendingSapphireAppPromotions,
  normalizeAppPromotions
} from '../src/core/promotionSources.js';

test('从 Dashboard API 提取今日未完成的 Daily Set 卡片', () => {
  const now = new Date(2026, 10, 3, 12, 0, 0).getTime();
  const cards = extractDailySetCardsFromDashboard({
    dashboard: {
      dailySetPromotions: {
        '2026-11-03': [{
          offerId: 'DailySet_App_Search_1',
          title: 'Upcoming live music events',
          promotionType: 'search',
          destinationUrl: 'https://www.bing.com/search?q=music',
          pointProgress: 0,
          pointProgressMax: 10,
          hash: 'hash-1'
        }, {
          offerId: 'DailySet_App_Search_2',
          title: 'New York City Fall Big Apple',
          promotionType: 'urlreward',
          destinationUrl: 'https://www.bing.com/search?q=nyc',
          pointProgress: 0,
          pointProgressMax: 10
        }, {
          offerId: 'DailySet_Done',
          title: 'Already complete',
          complete: true,
          pointProgressMax: 10
        }]
      }
    }
  }, now);

  assert.equal(cards.length, 2);
  assert.equal(cards[0].category, 'dailyset');
  assert.equal(cards[0].kind, 'explore_search');
  assert.equal(cards[0].hash, 'hash-1');
  assert.equal(cards[1].hash, '');
  assert.match(cards[1].destination, /bing\.com\/search/);
});

test('移动端 DAPI 活动可识别 sapphire、签到与阅读任务', () => {
  const promotions = normalizeAppPromotions({
    response: {
      promotions: [{
        name: 'Upcoming live music events',
        attributes: {
          offerid: 'Sapphire_Music_1',
          type: 'sapphire',
          pointprogress: '0',
          pointmax: '10',
          complete: 'false'
        }
      }, {
        name: 'Daily Check-In',
        attributes: {
          offerid: 'Gamification_Sapphire_DailyCheckIn',
          type: 'checkin',
          progress: '3',
          last_updated: '2026-11-03T01:00:00+08:00'
        }
      }, {
        name: 'Read to earn',
        attributes: {
          offerid: 'ENUS_readarticle3_30points',
          type: 'msnreadearn',
          pointprogress: '30',
          pointmax: '30'
        }
      }]
    }
  });

  assert.equal(promotions.length, 3);
  assert.equal(promotions[0].type, 'sapphire');
  assert.equal(promotions[0].progress, 0);
  assert.equal(promotions[0].max, 10);
  assert.equal(promotions[1].complete, false);
  assert.equal(promotions[2].complete, true);
  assert.equal(getPendingSapphireAppPromotions(promotions).length, 1);

  const checkIn = getAppCheckInStatusFromPromotions(
    promotions,
    new Date(2026, 10, 3, 12, 0, 0).getTime()
  );
  assert.equal(checkIn.isCurrentDayCompleted, true);
  assert.equal(checkIn.completedDays, 3);
  assert.equal(checkIn.source, 'dapi');
});

test('App 活动上报载荷使用 type 101 与 offerid', () => {
  assert.deepEqual(buildAppActivityPayload('Sapphire_Music_1', {
    id: 'activity-id',
    country: 'cn',
    channel: 'SAAndroid'
  }), {
    amount: 1,
    country: 'cn',
    id: 'activity-id',
    type: 101,
    channel: 'SAAndroid',
    attributes: { offerid: 'Sapphire_Music_1' }
  });
});
