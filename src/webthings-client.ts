/**
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/.
 */

import fetch, {RequestInit} from 'node-fetch';
import {EventEmitter} from 'events';
import {client as WebSocketClient, connection as WebSocketConnection, IClientConfig, IMessage} from 'websocket';
import {Device, DeviceDescription} from './device';
import {Event, EventDescription} from './event';
import {Agent} from 'https';

export class WebThingsClient extends EventEmitter {
  public static async local(token: string): Promise<WebThingsClient> {
    const address = 'localhost';
    let port = 8080;
    let https = false;
    let skipValidation = false;
    console.log(`Probing port ${port}`);
    const response = await fetch(`http://${address}:${port}`, {
      redirect: 'manual',
    });

    if (response.headers.get('Location')) {
      port = 4443;
      https = true;
      skipValidation = true;
      console.log(`HTTPS seems to be active, using port ${port} instead`);
    }

    return new WebThingsClient(address, port, token, https, skipValidation);
  }

    private readonly protocol: string;

    private readonly webSocketProtocol: string;

    private readonly fetchOptions: RequestInit = {};

    private readonly webSocketClientConfig: IClientConfig = {};

    private connection?: WebSocketConnection;

    // eslint-disable-next-line no-unused-vars
    constructor(public address: string, private port: number, public token: string, useHttps = false, skipValidation = false) {
      super();
      this.protocol = useHttps ? 'https' : 'http';
      this.webSocketProtocol = useHttps ? 'wss' : 'ws';

      if (skipValidation) {
        this.fetchOptions = {
          agent: new Agent({
            rejectUnauthorized: false,
          }),
        };
        this.webSocketClientConfig = {
          tlsOptions: {
            rejectUnauthorized: false,
          },
        };
      }
    }

    public async getDevices(): Promise<Device[]> {
      const descriptions = <DeviceDescription[]> await this.get('/things');
      return descriptions.map((description) => new Device(description, this));
    }

    public async getDevice(id: string): Promise<Device> {
      const description = <DeviceDescription> await this.get(`/things/${id}`);
      return new Device(description, this);
    }

    private async request(method: string, path: string, body?: unknown, args: Record<string, unknown> = {}) {
      const headers: { [key: string]: string } = {
        Accept: 'application/json',
        Authorization: `Bearer ${this.token}`,
      };
      const params = {
        ...this.fetchOptions,
        method: method,
        headers: headers,
      };
      if (!args.nobody) {
        headers['Content-Type'] = 'application/json';
        if (args.strbody) {
          params.body = `${body}`;
        } else {
          params.body = JSON.stringify(body);
        }
      }
      const response = await fetch(`${this.protocol}://${this.address}:${this.port}${path}`, params);

      if (response.status < 200 || response.status >= 300) {
        throw `${response.status}: ${response.statusText}`;
      }

      const contentType = response.headers.get('Content-Type') || '';

      if (contentType.indexOf('application/json') < 0) {
        if (args.expectnocontent) {
          return null;
        } else {
          throw `Content-Type is '${response.headers.get('Content-Type')}' but expected 'application/json'`;
        }
      }

      return await response.json();
    }

    public async get(path: string): Promise<unknown> {
      return this.request('GET', path, undefined, {nobody: true});
    }

    public async put(path: string, value?: unknown): Promise<unknown> {
      return this.request('PUT', path, value);
    }

    public async post(path: string, value?: unknown): Promise<unknown> {
      return this.request('POST', path, value);
    }

    public async delete(path: string): Promise<void> {
      this.request('DELETE', path, '', {strbody: true, expectnocontent: true});
    }

    public async connect(port = 8080): Promise<void> {
      const socketUrl = `${this.webSocketProtocol}://${this.address}:${port}/things`;
      const webSocketClient = new WebSocketClient(this.webSocketClientConfig);

      await new Promise<void>((resolve, reject) => {
        webSocketClient.on('connect', async (connection: WebSocketConnection) => {
          connection.on('error', (error: Error) => {
            this.emit('error', error);
          });

          connection.on('close', () => {
            this.emit('close');
          });

          connection.on('message', (message: IMessage) => {
            if (message.type === 'utf8' && message.utf8Data) {
              const msg = JSON.parse(message.utf8Data);
              this.emit('message', msg.id, msg.data);
              if ('id' in msg && 'data' in msg) {
                switch (msg.messageType) {
                  case 'propertyStatus':
                    for (const key in msg.data) {
                      this.emit('propertyChanged', msg.id, key, msg.data[key]);
                    }
                    break;
                  case 'actionStatus':
                    for (const key in msg.data) {
                      this.emit('actionTriggered', msg.id, key, msg.data[key]);
                    }
                    break;
                  case 'event':
                    for (const key in msg.data) {
                      this.emit('eventRaised', msg.id, key, msg.data[key]);
                    }
                    break;
                  case 'connected':
                    this.emit('connectStateChanged', msg.id, msg.data);
                    break;
                  case 'thingModified':
                    this.emit('deviceModified', msg.id, msg.data);
                    break;
                  case 'thingAdded':
                    this.emit('deviceAdded', msg.id, msg.data);
                    break;
                  case 'thingRemoved':
                    this.emit('deviceRemoved', msg.id, msg.data);
                    break;
                  default:
                    console.warn('Unknown message from socket', msg.id || '', ':', msg.messageType, '(', msg.data, ')');
                }
              } else if ('data' in msg) {
                switch (msg.messageType) {
                  case 'actionStatus':
                    if (Object.keys(msg.data).length == 1 && Object.keys(msg.data)[0] == 'pair') {
                      this.emit('pair', msg.data.pair);
                    }
                    break;
                  default:
                    console.warn('Unknown message from socket', msg.id || '', ':', msg.messageType, '(', msg.data, ')');
                }
              }
            }
          });

          this.connection = connection;
          resolve();
        });

        webSocketClient.on('connectFailed', (error: Error) => {
          reject(error);
        });

        webSocketClient.connect(`${socketUrl}?jwt=${this.token}`);
      });
    }

    public async disconnect(): Promise<void> {
      if (!this.connection) {
        throw Error('Socket not connected!');
      }
      this.connection.close();
    }

    public async subscribeEvents(device: Device, events: { [key: string]: Event }): Promise<void> {
      if (!this.connection) {
        throw Error('Socket not connected!');
      }
      const eventdescs: { [key: string]: EventDescription } = {};
      for (const eventName in events) {
        eventdescs[eventName] = events[eventName].description;
      }
      await this.connection.send(JSON.stringify({messageType: 'addEventSubscription', id: device.id(), data: eventdescs}));
    }
}
