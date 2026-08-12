import { HealthController } from './health.controller';

describe('HealthController', () => {
  it('reports service status', () => {
    const controller = new HealthController();
    expect(controller.check()).toEqual({
      status: 'ok',
      service: 'ros-identity',
    });
  });
});
