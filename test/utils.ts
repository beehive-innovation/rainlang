import { assert } from "chai";

/**
 * Deployer Address to fetch the opmeta from subgraph
 */
export const deployerAddress = "0x225F36bEc16f5d78baa3462B53CC2A6C24FAAEc0";

export const assertError = async (f: any, s: string, e: string) => {
    let didError = false;
    try {
        await f();
    } catch (e: any) {
        assert(JSON.stringify(e).includes(s), `error string ${JSON.stringify(e)} does not include ${s}`);
        didError = true;
    }
    assert(didError, e);
};
