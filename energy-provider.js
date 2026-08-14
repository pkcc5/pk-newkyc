/**
 * energy-provider.js
 * TronZap 能量租赁统一接口
 */

const axios = require('axios');
const crypto = require('crypto');

class TronZapProvider {
  constructor() {
    this.apiBase = 'https://api.tronzap.com/v1';
    this.apiToken = process.env.TRONZAP_API_TOKEN;
    this.apiSecret = process.env.TRONZAP_API_SECRET;
    this.timeout = 10000;
  }

  /**
   * 计算签名
   */
  generateSignature(requestBody) {
    return crypto
      .createHash('sha256')
      .update(requestBody + this.apiSecret)
      .digest('hex');
  }

  /**
   * 获取请求头
   */
  getHeaders(requestBody) {
    const signature = this.generateSignature(requestBody);
    return {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${this.apiToken}`,
      'X-Signature': signature
    };
  }

  /**
   * 获取账户余额
   */
  async getBalance() {
    try {
      const requestBody = JSON.stringify({});
      const headers = this.getHeaders(requestBody);
      const response = await axios.post(
        `${this.apiBase}/balance`,
        requestBody,
        { headers, timeout: this.timeout }
      );
      if (response.data && response.data.code === 0) {
        return parseFloat(response.data.result.balance || 0);
      }
      throw new Error(`TronZap API 错误: ${response.data?.message}`);
    } catch (error) {
      console.error('[TronZap] 获取余额失败:', error.message);
      if (error.response) {
        console.error('[TronZap] 错误响应:', JSON.stringify(error.response.data, null, 2));
      }
      throw error;
    }
  }

  /**
   * 获取能量价格和服务信息
   */
  async getServices() {
    try {
      const requestBody = JSON.stringify({});
      const headers = this.getHeaders(requestBody);
      const response = await axios.post(
        `${this.apiBase}/services`,
        requestBody,
        { headers, timeout: this.timeout }
      );
      if (response.data && response.data.code === 0) {
        return response.data.result;
      }
      throw new Error(response.data?.message || '获取服务信息失败');
    } catch (error) {
      console.error('[TronZap] 获取服务信息失败:', error.message);
      throw error;
    }
  }

  /**
   * 获取指定能量的价格
   */
  async getPrice(energyAmount = 65000) {
    try {
      const services = await this.getServices();
      let price = 3.0;
      if (services && services.energy) {
        for (const service of services.energy) {
          if (service.energy_amount === energyAmount) {
            price = parseFloat(service.price_trx);
            break;
          }
        }
      }
      return price;
    } catch (error) {
      console.error('[TronZap] 获取价格失败:', error.message);
      return 3.0;
    }
  }

  /**
   * 购买能量并委托到指定地址
   * 使用正确的 API 格式：service + params
   */
  async buyEnergy(targetAddress, energyAmount = 65000, duration = 1, retryCount = 0) {
    const maxRetries = 2;
    const retryDelay = 1000;

    try {
      // 使用正确的 API 格式
      const requestBody = JSON.stringify({
        external_id: `tx_${Date.now()}_${Math.random().toString(36).substr(2, 8)}`,
        service: 'energy',
        params: {
          address: targetAddress,
          energy_amount: energyAmount,
          duration: duration
        }
      });

      const headers = this.getHeaders(requestBody);
      console.log(`[TronZap] 购买能量请求:`, {
        service: 'energy',
        address: targetAddress,
        energy_amount: energyAmount,
        duration: duration
      });

      const response = await axios.post(
        `${this.apiBase}/transaction/new`,
        requestBody,
        { headers, timeout: this.timeout }
      );

      console.log(`[TronZap] 响应状态: ${response.status}`);
      console.log(`[TronZap] 响应数据:`, JSON.stringify(response.data, null, 2));

      if (response.data && response.data.code === 0) {
        console.log(`[TronZap] 能量购买成功: ${response.data.result?.transaction_id}`);
        return {
          success: true,
          txId: response.data.result?.transaction_id,
          cost: response.data.result?.cost_trx || 0,
          energyAmount: energyAmount
        };
      }

      const errorCode = response.data?.code;
      const errorMsg = response.data?.message || '未知错误';

      if (errorCode === 6) {
        throw new Error(`INSUFFICIENT_FUNDS: 余额不足`);
      }

      if (retryCount < maxRetries && errorCode !== 1 && errorCode !== 6) {
        console.log(`[TronZap] 购买失败，${retryDelay}ms 后重试 (${retryCount + 1}/${maxRetries})`);
        await new Promise(resolve => setTimeout(resolve, retryDelay));
        return this.buyEnergy(targetAddress, energyAmount, duration, retryCount + 1);
      }

      throw new Error(errorMsg);
    } catch (error) {
      if (error.message.includes('INSUFFICIENT_FUNDS')) throw error;

      if (retryCount < maxRetries && !error.message.includes('service')) {
        console.log(`[TronZap] 网络错误，${retryDelay}ms 后重试 (${retryCount + 1}/${maxRetries})`);
        await new Promise(resolve => setTimeout(resolve, retryDelay));
        return this.buyEnergy(targetAddress, energyAmount, duration, retryCount + 1);
      }

      console.error('[TronZap] 购买能量失败:', error.message);
      if (error.response) {
        console.error(`[TronZap] 错误响应状态: ${error.response.status}`);
        console.error(`[TronZap] 错误响应数据:`, JSON.stringify(error.response.data, null, 2));
      }
      throw error;
    }
  }

  /**
   * 获取充值地址
   */
  async getRechargeAddress() {
    const customAddress = process.env.TRONZAP_RECHARGE_ADDRESS;
    if (!customAddress) {
      throw new Error('请在环境变量中设置 TRONZAP_RECHARGE_ADDRESS（TronZap 专属充值地址）');
    }
    console.log('[TronZap] 使用专属充值地址:', customAddress);
    return customAddress;
  }
}

module.exports = new TronZapProvider();
