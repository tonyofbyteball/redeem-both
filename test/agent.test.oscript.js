// uses `aa-testkit` testing framework for AA tests. Docs can be found here `https://github.com/valyakin/aa-testkit`
// `e` standard functions and `expect` from `chai` are available globally
// `Testkit`, `Network`, `Nodes` and `Utils` from `aa-testkit` are available globally too
const path = require('path')
const { expect } = require('chai');
const isInteger = require('lodash.isinteger');

function round(n, precision) {
	return Math.round(n * 10 ** precision) / 10 ** precision;
}

describe('Buy T2 through a buffer AA using several partial executions', function () {
	this.timeout(120000)


	before(async () => {
		this.network = await Network.create()
			.with.numberOfWitnesses(1)
			.with.agent({ bank: path.join(__dirname, '../node_modules/bank-aa/bank.oscript') })
			.with.agent({ bs: path.join(__dirname, '../node_modules/bonded-stablecoin/bonded-stablecoin.oscript') })
			.with.agent({ bsf: path.join(__dirname, '../node_modules/bonded-stablecoin/bonded-stablecoin-factory.oscript') })
			.with.agent({ daf2: path.join(__dirname, '../node_modules/bonded-stablecoin/define-asset2-forwarder.oscript') })
			.with.agent({ governance: path.join(__dirname, '../node_modules/bonded-stablecoin/governance.oscript') })
			.with.agent({ deposits: path.join(__dirname, '../node_modules/bonded-stablecoin/deposits.oscript') })
			.with.agent({ factory: path.join(__dirname, '../factory.oscript') })
			.with.agent({ carburetor: path.join(__dirname, '../agent.oscript') })
			.with.wallet({ oracle: 1e6 })
			.with.wallet({ alice: 100000e9 })
			.with.wallet({ bob: 1000e9 })
			//	.with.explorer()
			.run()
		// console.log('--- agents\n', this.network.agent)
		//	console.log('--- wallets\n', this.network.wallet)
		this.oracle = this.network.wallet.oracle
		this.oracleAddress = await this.oracle.getAddress()
		this.alice = this.network.wallet.alice
		this.aliceAddress = await this.alice.getAddress()
		this.bob = this.network.wallet.bob
		this.bobAddress = await this.bob.getAddress()

		this.carburetorAddress = this.network.agent.carburetor
		this.factoryAddress = this.network.agent.factory

		// this.curveAddress = this.network.agent.carburetor
		this.n = 0.5;
		this.m = 2;
		this.decimals1 = 9;
		this.decimals2 = 2;

		console.log("carburetorAddress", this.carburetorAddress)
		//	this.explorer = await this.network.newObyteExplorer().ready()

		const balance = await this.bob.getBalance()
		// console.log(balance)
		expect(balance.base.stable).to.be.equal(1000e9)
	})

	it('Post data feed', async () => {
		const price = 20
		const { unit, error } = await this.oracle.sendMulti({
			messages: [{
				app: 'data_feed',
				payload: {
					GBYTE_USD: price,
				}
			}],
		})

		expect(error).to.be.null
		expect(unit).to.be.validUnit

		const { unitObj } = await this.oracle.getUnitInfo({ unit: unit })
		const dfMessage = unitObj.messages.find(m => m.app === 'data_feed')
		expect(dfMessage.payload.GBYTE_USD).to.be.equal(20)
		await this.network.witnessUntilStable(unit)

		this.price = price
	})

	it('Bob defines a new stablecoin', async () => {
		const { error: tf_error } = await this.network.timefreeze()
		expect(tf_error).to.be.null

		this.ts = Math.round(Date.now() / 1000)
		this.fee_multiplier = 5
		this.interest_rate = 0.1
		const { unit, error } = await this.bob.triggerAaWithData({
			toAddress: this.network.agent.bsf,
			amount: 15000,
			data: {
				reserve_asset: 'base',
				reserve_asset_decimals: 9,
				decimals1: this.decimals1,
				decimals2: this.decimals2,
				m: this.m,
				n: this.n,
				interest_rate: this.interest_rate,
				allow_grants: true,
				oracle1: this.oracleAddress,
				feed_name1: 'GBYTE_USD',
			},
		})

		expect(error).to.be.null
		expect(unit).to.be.validUnit

		const { response } = await this.network.getAaResponseToUnitOnNode(this.bob, unit)
		//	const { response } = await this.network.getAaResponseToUnit(unit)
		//	await this.network.witnessUntilStable(response.response_unit)

		expect(response.response.error).to.be.undefined
		expect(response.bounced).to.be.false
		expect(response.response_unit).to.be.validUnit

		const { vars } = await this.bob.readAAStateVars(this.network.agent.bsf)

		expect(Object.keys(vars).length).to.be.equal(6)
		for (let name in vars) {
			if (name.startsWith('curve_')) {
				this.curve_aa = name.substr(6)
				expect(vars[name]).to.be.equal("s1^2 s2^0.5")
			}
		}
		this.asset1 = vars['asset_' + this.curve_aa + '_1'];
		this.asset2 = vars['asset_' + this.curve_aa + '_2'];
		this.asset_stable = vars['asset_' + this.curve_aa + '_stable'];
		this.deposit_aa = vars['deposit_aa_' + this.curve_aa];
		this.governance_aa = vars['governance_aa_' + this.curve_aa];

		const { vars: curve_vars } = await this.bob.readAAStateVars(this.curve_aa)

		expect(curve_vars['asset1']).to.be.equal(this.asset1)
		expect(curve_vars['asset2']).to.be.equal(this.asset2)
		expect(curve_vars['governance_aa']).to.be.equal(this.governance_aa)
		expect(curve_vars['growth_factor']).to.be.equal(1)
		expect(curve_vars['dilution_factor']).to.be.equal(1)
		expect(curve_vars['interest_rate']).to.be.equal(0.1)
		expect(parseInt(curve_vars['rate_update_ts'])).to.be.eq(this.ts)

		this.getReserve = (s1, s2) => Math.ceil(1e9 * (s1 / 1e9) ** 2 * (s2 / 1e2) ** 0.5)
		this.getP2 = (s1, s2) => (s1 / 1e9) ** 2 * 0.5 / (s2 / 1e2) ** 0.5
		this.getFee = (avg_reserve, old_distance, new_distance) => Math.ceil(avg_reserve * (new_distance ** 2 - old_distance ** 2) * this.fee_multiplier);
		this.buy = (tokens1, tokens2, bNoUpdate) => {
			const new_supply1 = this.supply1 + tokens1
			const new_supply2 = this.supply2 + tokens2
			const new_reserve = this.getReserve(new_supply1, new_supply2)
			const amount = new_reserve - this.reserve
			const abs_reserve_delta = Math.abs(amount)
			const avg_reserve = (this.reserve + new_reserve) / 2
			const p2 = this.getP2(new_supply1, new_supply2)

			const old_distance = this.reserve ? Math.abs(this.p2 - this.target_p2) / this.target_p2 : 0
			const new_distance = Math.abs(p2 - this.target_p2) / this.target_p2
			const regular_fee = this.getFee(avg_reserve, old_distance, new_distance);
			const reserve_delta = new_reserve - this.reserve;
			let fee, reserve_needed, reward;

			if (old_distance === 0 && new_distance === 0) {
				fee = 0;
				reward = 0;
				reserve_needed = reserve_delta;
			} else if (new_distance >= old_distance) {
				fee = regular_fee;
				reward = 0;
				reserve_needed = reserve_delta + fee;
			} else {
				fee = 0;
				reward = Math.floor((1 - new_distance / old_distance) * this.fast_capacity);
				reserve_needed = reserve_delta - reward; 
			}
			
			// if (fee > 0) {
			// 	const reverse_reward = Math.floor((1 - old_distance / new_distance) * this.fast_capacity); // rough approximation
			// }
			
			const fee_percent = round(fee / abs_reserve_delta * 100, 14)
			// const reward = old_distance ? Math.floor((1 - new_distance / old_distance) * this.fast_capacity) : 0;
			const reward_percent = round(reward / abs_reserve_delta * 100, 4)

			const payout = - reserve_needed - 1000;

			// console.log('p2 =', p2, 'target p2 =', this.target_p2, 'amount =', amount, 'fee =', fee, 'reward =', reward, 'old distance =', old_distance, 'new distance =', new_distance, 'fast capacity =', this.fast_capacity)

			if (fee > 0 && reward > 0)
				throw Error("both fee and reward are positive");
			if (fee < 0 && reward < 0)
				throw Error("both fee and reward are negative");

			if (!bNoUpdate) {
				this.p2 = p2
				this.distance = new_distance
				if (fee > 0) {
					this.slow_capacity += Math.floor(fee / 2)
					this.fast_capacity += fee - Math.floor(fee / 2)
				}
				else if (reward > 0)
					this.fast_capacity -= reward

				this.supply1 += tokens1
				this.supply2 += tokens2
				this.reserve += amount
			}

			return { amount, fee, fee_percent, reward, reward_percent, payout, reserve_needed }
		}

		this.supply1 = 0
		this.supply2 = 0
		this.reserve = 0
		this.slow_capacity = 0
		this.fast_capacity = 0
		this.distance = 0
	})

	it('Alice create carburetor', async () => {
		const { unit, error } = await this.alice.triggerAaWithData({
			toAddress: this.factoryAddress,
			amount: 1e4,
			data: {
				create: 1
			}
		})

		expect(error).to.be.null
		expect(unit).to.be.validUnit

		const { response } = await this.network.getAaResponseToUnit(unit)

		expect(response.response.responseVars.carburetor).to.be.not.undefined
		expect(response.response.error).to.be.undefined
		expect(response.bounced).to.be.false
		expect(response.response_unit).to.be.validUnit

		this.currentCarburetor = response.response.responseVars.carburetor;
	})

	it('Alice buys tokens', async () => {
		this.target_p2 = 1 / this.price
		const tokens1 = 1e9
		const tokens2 = 100e2
		const { amount } = this.buy(tokens1, tokens2)
		const { unit, error } = await this.alice.triggerAaWithData({
			toAddress: this.curve_aa,
			amount: amount + 1000,
			data: {
				tokens1: tokens1,
				tokens2: tokens2,
			},
		})

		expect(error).to.be.null
		expect(unit).to.be.validUnit

		const { response } = await this.network.getAaResponseToUnit(unit)
		//	await this.network.witnessUntilStable(response.response_unit)

		expect(response.response.error).to.be.undefined
		expect(response.bounced).to.be.false
		expect(response.response_unit).to.be.validUnit

		const { vars } = await this.alice.readAAStateVars(this.curve_aa)

		expect(vars['supply1']).to.be.equal(this.supply1)
		expect(vars['supply2']).to.be.equal(this.supply2)
		expect(vars['reserve']).to.be.equal(this.reserve)
		expect(parseFloat(parseFloat(vars['p2']).toPrecision(13))).to.be.equal(this.p2)
		expect(vars['slow_capacity']).to.be.undefined
		expect(vars['fast_capacity']).to.be.undefined
		expect(vars['lost_peg_ts']).to.be.undefined

		const { unitObj } = await this.alice.getUnitInfo({ unit: response.response_unit })

		expect(Utils.getExternalPayments(unitObj)).to.deep.equalInAnyOrder([
			{
				address: this.aliceAddress,
				asset: this.asset1,
				amount: tokens1,
			},
			{
				address: this.aliceAddress,
				asset: this.asset2,
				amount: tokens2,
			},
		])

	})


	it('Alice create exchange and add tokens 2', async () => {
		this.amount2 = 4512;

		const { unit, error } = await this.alice.sendMulti({
			asset: this.asset2,
			base_outputs: [{ address: this.currentCarburetor, amount: 1e4 }],
			asset_outputs: [{ address: this.currentCarburetor, amount: this.amount2 }],
			spend_unconfirmed: 'all',
			messages: [{
				app: 'data',
				payload: {
					curve_address: this.curve_aa
				}
			}]
		});

		expect(error).to.be.null
		expect(unit).to.be.validUnit
		
		const { unitObj } = await this.alice.getUnitInfo({ unit })

		expect(Utils.getExternalPayments(unitObj)).to.deep.equalInAnyOrder([
			{
				address: this.currentCarburetor,
				amount: this.amount2,
				asset: this.asset2
			},
			{
				address: this.currentCarburetor,
				amount: 1e4
			}
		]);
	});

	it("Alice withdraw tokens1", async () => {
		// const { unit, error } = await this.alice.triggerAaWithData({
		// 	toAddress: this.currentCarburetor,
		// 	spend_unconfirmed: 'all',
		// 	amount: 1e4,
		// 	data: {
		// 		curve_address: this.curve_aa,
		// 		withdraw: 1,
		// 		tokens1: 1500
		// 	},
		// });

		// this.amount1 = this.amount1 - 1500

		// expect(error).to.be.null
		// expect(unit).to.be.validUnit

		// const { response } = await this.network.getAaResponseToUnit(unit);

		// console.log("response", response.response_unit)

		// const { response: nextRes } = await this.network.getAaResponseToUnit(response.response_unit);

		// console.log("response", nextRes)

		// const { unitObj } = await this.alice.getUnitInfo({ unit })

		// expect(Utils.getExternalPayments(unitObj)).to.deep.equalInAnyOrder([
		// 	{
		// 		address: this.aliceAddress,
		// 		amount: 1500,
		// 		asset: this.asset1
		// 	}
		// ]);

		// expect(response.updatedStateVars[this.currentCarburetor][this.aliceExchangeId].value.amount1).to.be.equal(this.amount1);
	});


	it("Alice execute", async () => {
		const oldAliceBalance = await this.alice.getOutputsBalanceOf(this.aliceAddress);
		const { vars: curve_vars } = await this.alice.readAAStateVars(this.curve_aa)

		this.amount1 = 59239545;
		const { unit, error } = await this.alice.sendMulti({
			asset: this.asset1,
			base_outputs: [{ address: this.currentCarburetor, amount: 1e4 }],
			asset_outputs: [{ address: this.currentCarburetor, amount: this.amount1 }],
			spend_unconfirmed: 'all',
			messages: [{
				app: 'data',
				payload: {
				//	auto_withdraw: 1,
					curve_address: this.curve_aa
				}
			}]
		});

		expect(error).to.be.null
		expect(unit).to.be.validUnit
		const { unitObj: requestUnitObj } = await this.alice.getUnitInfo({ unit })

		const { response } = await this.network.getAaResponseToUnit(unit);

		this.count1FromCarburetor = response.response.responseVars.count1;
		this.count2FromCarburetor = response.response.responseVars.count2;

		expect(response.response.error).to.be.undefined
		expect(response.bounced).to.be.false
		expect(response.response_unit).to.be.validUnit
		expect(response.response.responseVars.fee_percent).to.be.lessThan(1);

		const { response: nextResponse } = await this.network.getAaResponseToUnit(response.objResponseUnit.unit);

		expect(nextResponse.response.error).to.be.undefined
		expect(nextResponse.bounced).to.be.false
		expect(nextResponse.response_unit).to.be.validUnit
		expect(nextResponse.response.responseVars['fee%']).to.be.equal("0%");


		const new_supply1 = curve_vars.supply1 - this.amount1;
		const new_supply2 = curve_vars.supply2 - this.amount2;

		const s1 = new_supply1 / 10 ** this.decimals1;
		const s2 = new_supply2 / 10 ** this.decimals2;

		const expectT1 = ((curve_vars.p2 / (curve_vars.dilution_factor * this.n * (isInteger(this.n * 2) ? Math.sqrt(s2 ** ((this.n - 1) * 2)) : s2 ** (this.n - 1)))) ** (1 / this.m)) - (curve_vars.supply1 / 10 ** this.decimals1);
		const expectT2 = ((curve_vars.p2 / (curve_vars.dilution_factor * (s1 ** this.m) * this.n)) ** (1 / (this.n - 1))) - curve_vars.supply2 / 10 ** this.decimals2;

		let count1, count2, change1, change2;

		const expectT1WithoutDecimals = Math.abs(Math.round(expectT1 * 10 ** this.decimals1));
		const expectT2WithoutDecimals = Math.abs(Math.round(expectT2 * 10 ** this.decimals2));
		
		if (expectT2WithoutDecimals < this.amount2) {
			count1 = this.amount1;
			count2 = expectT2WithoutDecimals;

			change1 = 0;
			change2 = this.amount2 - expectT2WithoutDecimals;
		} else if (expectT1WithoutDecimals < this.amount1) {
			count1 = expectT1WithoutDecimals;
			count2 = this.amount2;

			change1 = this.amount1 - expectT1WithoutDecimals;
			change2 = 0;
		} else {
			count1 = 0;
			count2 = 0;

			change1 = 0;
			change2 = 0;
		}

		expect(this.count1FromCarburetor).to.be.equal(count1);
		expect(this.count2FromCarburetor).to.be.equal(count2);


		const { fee, payout } = this.buy(-count1, -count2);

		const { unitObj } = await this.alice.getUnitInfo({ unit: response.response_unit })
		const expectedChange = change1
			? {
				asset: this.asset1,
				address: this.aliceAddress,
				amount: change1,
			}
			: {
				asset: this.asset2,
				address: this.aliceAddress,
				amount: change2,
			}
		expect(Utils.getExternalPayments(unitObj)).to.deep.equalInAnyOrder([
			{
				asset: this.asset2,
				address: this.curve_aa,
				amount: count2,
			},
			{
				asset: this.asset1,
				address: this.curve_aa,
				amount: count1,
			},
		//	expectedChange,
		]);

		const { unitObj: unitObj2 } = await this.alice.getUnitInfo({ unit: nextResponse.response_unit })
		expect(Utils.getExternalPayments(unitObj2)).to.deep.equalInAnyOrder([
			{
				address: this.aliceAddress,
				amount: payout,
			},
		]);

		const newAliceBalance = await this.alice.getOutputsBalanceOf(this.aliceAddress);
		expect(oldAliceBalance.base.total + payout - 1e4 - requestUnitObj.headers_commission - requestUnitObj.payload_commission).to.be.equal(newAliceBalance.base.total);
	});

	after(async () => {
		await this.network.stop();
	})
});
