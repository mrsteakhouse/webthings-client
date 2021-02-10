/**
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/.*
 */

import {Link} from './link';
import {Device} from './device';
import {hrefFromLinksArray} from './helpers';

export interface PropertyDescription {
    title: string;
    type: string;
    '@type': string[];
    unit: string;
    description: string;
    minimum: number;
    maximum: number;
    readOnly: boolean;
    multipleOf: number;
    links: Link[];
}

type Value = string | number | boolean | null | undefined

export class Property {
  // eslint-disable-next-line no-unused-vars
  constructor(public name: string, public description: PropertyDescription, public device: Device) {
  }

  public async getValue(): Promise<Value> {
    const wrapper = <Record<string, Value>> await this.device.client.get(this.href());
    return wrapper[this.name];
  }

  public async setValue(value: Value): Promise<unknown> {
    const wrapper = {[this.name]: value};
    return this.device.client.put(this.href(), wrapper);
  }

  public href(): string {
    return hrefFromLinksArray(this.description.links, 'property');
  }
}
