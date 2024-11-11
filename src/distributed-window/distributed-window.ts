import { InjectableConstructor } from "../injectable-constructor/injectable-constructor";
import { SequentialInvocationQueue, Serializable } from "../sequential-invocation-queue/sequential-invocation-queue";
import { SpinWaitLock } from "../spin-wait-lock/spin-wait-lock";

//Take care Identity of elements.
//1. Duplicates
//2. Gaps 
//3. Stable sort may require duplicates.

export interface IWindowTimeoutStrategy {
    type: string;
    timeout: number;
}

export class ExpireOnLastElement implements IWindowTimeoutStrategy {
    public readonly type = "ExpireOnLastElement";
    constructor(public readonly timeout: number) { }
}

export class ExpireOnFirstElement implements IWindowTimeoutStrategy {
    public readonly type = "ExpireOnFirstElement";
    constructor(public readonly timeout: number) { }
}

export interface IAccumulator<T> {
    // private readonly accumulate = true,
    append(value: T | T[]): Promise<number>;

    //It should be atomic operation.
    //It should drain exactly count specified or 0 elements, anything else will break the atomicity.
    drain(count: number): Promise<T[]>;

    //Flush all elements, it should be atomic operation.
    flush(): Promise<T[]>;
}

export class DistributedWindow<T extends Serializable> {

    //Fit for multiple threads.
    //Fit for single threads multiple sessions.(node.js async)
    //Fit for multiple processes across machines.

    constructor(
        private readonly windowSize: number,
        private readonly distributedAccumulator: IAccumulator<T>,
    ) {
        if (windowSize <= 0) throw new Error("windowSize must be greater than 0");
        if (windowSize === 1) this.window = async (newValue: T) => [[newValue]];//Optimization for windowSize === 1, which is just a pass-through.
    }

    public async window(newValue: T): Promise<T[][] | undefined> {
        const accumulatedLength = await this.distributedAccumulator.append(newValue);//Instruction 1
        if (accumulatedLength % this.windowSize === 0) {
            const result = new Array<T[]>();
            const allElements = await this.distributedAccumulator.drain(accumulatedLength); //Instruction 2
            if (allElements.length === 0) return undefined;//This happens when some other thread has already drained the elements, which is simple delay between Instruction 1 and Instruction 2.

            while (allElements.length % this.windowSize !== 0) {
                const innerWindows = await this.window(allElements.pop());//Re-accumulate the elements until multiple of window size. This can change the sequence of elements
                if (innerWindows !== undefined) {
                    result.push(...innerWindows);
                }
            }

            for (let index = 0; index < allElements.length; index += this.windowSize) {
                result.push(allElements.slice(index, index + this.windowSize));
            }
            return result;
        }
        else {
            return undefined;
        }
    }

    public async flush(): Promise<T[][]> {
        const result = new Array<T[]>();
        const allElements = await this.distributedAccumulator.flush();
        for (let index = 0; index < allElements.length; index += this.windowSize) {
            result.push(allElements.slice(index, index + this.windowSize));
        }
        return result;
    }
}

export interface IDistributedSortedSet<T> {
    //Should have the responsibility of how many active sessions it has to hold
    //Any sessions to be flushed should be returned in the next purge method

    add(key: T, sortId: number): Promise<boolean>;

    // Should remove the scanned items from the set, should be atomic.
    purge(sortId: number, operator: "lt"): Promise<T[]>;

    flush(): Promise<T[]>;
}

export class DistributedWindowOnIdentity<T extends Serializable> {

    constructor(
        private readonly name: string,
        private readonly windowSize: number,
        private readonly distributedSortedSet: IDistributedSortedSet<string>,
        private readonly distributedAccumulatorResolver: (key: string) => IAccumulator<T>,
    ) { }

    public async window(identity: number, payload: T): Promise<T[][] | undefined> {
        const identityBucket = identity - (identity % this.windowSize);
        const bucketKey = `${this.name} ${identityBucket}`;
        const dw = await this.distributedWindowResolver(bucketKey);
        const results = await dw.window(payload) ?? new Array<T[]>();
        const inserted = await this.distributedSortedSet.add(bucketKey, identityBucket);// Instruction 1
        if (inserted === true) {
            const oldBuckets = await this.distributedSortedSet.purge(identity, "lt");// Instruction 2
            for (const oldBucket of oldBuckets) {
                const dw = await this.distributedWindowResolver(oldBucket);
                const records = await dw.flush();
                results.push(...records);
            }
        }
        return results.length === 0 ? undefined : results;
    }

    public async flush(): Promise<T[][]> {
        const allBuckets = await this.distributedSortedSet.flush();
        const results = new Array<T[]>();
        for (const bucket of allBuckets) {
            const dw = await this.distributedWindowResolver(bucket);
            const records = await dw.flush();
            results.push(...records);
        }
        return results;
    }

    private async distributedWindowResolver(key: string): Promise<DistributedWindow<T>> {
        const acc = await this.distributedAccumulatorResolver(key);
        return new DistributedWindow<T>(this.windowSize, acc);
    }

}

async function main() {

    const testAcc = new class implements IAccumulator<string> {
        private readonly arr = new Set<string>();
        async append(value: string | string[]): Promise<number> {
            if (Array.isArray(value)) {
                for (const val of value) {
                    this.arr.add(val);
                }
            }
            else {
                this.arr.add(value);
            }
            return this.arr.size;
        }
        async drain(count: number): Promise<string[]> {
            return Array.from(this.arr.values()).splice(0, count);
        }
        async flush(): Promise<string[]> {
            return Array.from(this.arr.values()).splice(0, this.arr.size);
        }
    }

    const window = new DistributedWindow<string>(3, testAcc);

    for (let index = 0; index < 14; index++) {
        console.log(`${index}: ${await window.window("A")}`);
    }

    console.log(await window.flush());
}

main()
    .then(() => console.log("Done"))
    .catch(console.error);    