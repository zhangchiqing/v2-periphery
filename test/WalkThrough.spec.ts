import chai, { expect } from 'chai'
import { Contract } from 'ethers'
import { Zero, MaxUint256 } from 'ethers/constants'
import { bigNumberify } from 'ethers/utils'
import { solidity, MockProvider, createFixtureLoader } from 'ethereum-waffle'

import { expandTo18Decimals, MINIMUM_LIQUIDITY } from './shared/utilities'
import { v2Fixture } from './shared/fixtures'

chai.use(solidity)

const overrides = {
  gasLimit: 9999999
}

enum RouterVersion {
  UniswapV2Router01 = 'UniswapV2Router01',
  UniswapV2Router02 = 'UniswapV2Router02'
}

describe('UniswapV2Router{01,02}', () => {
  for (const routerVersion of Object.keys(RouterVersion)) {
    const provider = new MockProvider({
      hardfork: 'istanbul',
      mnemonic: 'horn horn horn horn horn horn horn horn horn horn horn horn',
      gasLimit: 9999999
    })
    const [wallet, lisa, lily, tim] = provider.getWallets()
    const loadFixture = createFixtureLoader(provider, [wallet])

    let token0: Contract
    let token1: Contract
    let router: Contract
    let pair: Contract
    beforeEach(async function() {
      const fixture = await loadFixture(v2Fixture)
      token0 = fixture.token0
      token1 = fixture.token1
      router = {
        [RouterVersion.UniswapV2Router01]: fixture.router01,
        [RouterVersion.UniswapV2Router02]: fixture.router02
      }[routerVersion as RouterVersion]
      pair = fixture.pair
    })

    afterEach(async function() {
      expect(await provider.getBalance(router.address)).to.eq(Zero)
    })

    describe(routerVersion, () => {
      it('should add liquidity, mint and remove liquidity', async () => {
        // setup lisa's account with 5 tokenA and 20 tokenB
        await token0.transfer(lisa.address, expandTo18Decimals(5))
        await token1.transfer(lisa.address, expandTo18Decimals(20))

        // check lisa's account balance of tokenA and tokenB
        expect(await token0.balanceOf(lisa.address)).to.eq(expandTo18Decimals(5))
        expect(await token1.balanceOf(lisa.address)).to.eq(expandTo18Decimals(20))

        // lisa needs to approve uniswap to transfer her tokenA and tokenB on her behalf before calling
        // addLiquidity, otherwise addLiquidity will fail
        await token0.connect(lisa).approve(router.address, MaxUint256)
        await token1.connect(lisa).approve(router.address, MaxUint256)

        // lisa add 5 tokenA and 20 tokenB to the pool, and receive about 10 liquidity token
        await router.connect(lisa).addLiquidity(
          token0.address,
          token1.address,
          expandTo18Decimals(5),
          expandTo18Decimals(20),
          0,
          0,
          lisa.address,
          MaxUint256,
          overrides
        )

        // check lisa has received about 10 liquidity token
        // the MINIMUM_LIQUIDITY is a tiny amount locked from the first liquidity provider
        expect(await pair.balanceOf(lisa.address)).to.eq(expandTo18Decimals(10).sub(MINIMUM_LIQUIDITY))

        // now lily also wants to become a liquidity provider
        // let's setup her account first
        // lily will have 50 tokenA and 200 tokenB
        await token0.transfer(lily.address, expandTo18Decimals(50))
        await token1.transfer(lily.address, expandTo18Decimals(200))

        // lily also needs to approve uniswap to transfer her tokenA and tokenB on her behalf
        await token0.connect(lily).approve(router.address, MaxUint256)
        await token1.connect(lily).approve(router.address, MaxUint256)

        // lily add all her 50 tokenA and 200 tokenB to the pool
        await router.connect(lily).addLiquidity(
          token0.address,
          token1.address,
          expandTo18Decimals(50),
          expandTo18Decimals(200),
          0,
          0,
          lily.address,
          MaxUint256,
          overrides
        )

        // confirm lily now owns 100 liquidity tokens
        expect(await pair.balanceOf(lily.address)).to.eq(expandTo18Decimals(100))

        // after lisa and lily adding liquidity to the pool,
        // confirm that now the pool has 55 tokenA and 220 tokenB in total
        expect(await token0.balanceOf(pair.address)).to.eq(expandTo18Decimals(55))
        expect(await token1.balanceOf(pair.address)).to.eq(expandTo18Decimals(220))

        // after lisa and lily adding liquidity,
        // now lisa owns 10 liquidity tokens, lily owns the rest 100 liquidity token.
        // the total supply is 110 tokens, lisa owns 1/11 = 9.0909%, and lily owns 10/11 = 90.9090%
        expect(await pair.totalSupply()).to.eq(expandTo18Decimals(110))

        // now Trader tim wants to swap tokens,
        // he first quotes the price to see how many tokenB he can get out if he swap 10 tokenA
        // he should get about 220 - 55 * 220 / (55 + 10 * 0.997) = 33.760197014
        expect(
          await router.getAmountOut(
            expandTo18Decimals(10),
            expandTo18Decimals(55),
            expandTo18Decimals(220))
        ).to.eq(bigNumberify('33760197014006464522'))

        // before tim can swap tokens, he needs to approve uniswap to transfer tokens on
        // his behalf, otherwise "swap" call will fail
        await token0.connect(tim).approve(router.address, MaxUint256)
        await token1.connect(tim).approve(router.address, MaxUint256)

        // setup tim's account with 10 tokenA
        await token0.transfer(tim.address, expandTo18Decimals(10))

        // tim swap 10 tokenA with a minimum specified as 33760197014006464522,
        // which means if the price changes due to some race condition,
        // tim won't be able to get the minimum amount, then the tx will fail.
        // 33760197014006464522 is the max tokenB amount he can swap with 10 tokenA,
        // adding 1 more will fail.
        await router.connect(tim).swapExactTokensForTokens(
          expandTo18Decimals(10),
          bigNumberify('33760197014006464522'), // amountOutMin
          [token0.address, token1.address],
          tim.address,
          MaxUint256, // deadline
          overrides
        )

        // after the swap, tim now has 0 tokenA and 33.760197014006464522 tokenB
        expect(await token0.balanceOf(tim.address)).to.eq(0)
        expect(await token1.balanceOf(tim.address)).to.eq(bigNumberify('33760197014006464522'))

        // after tim's swap, the pool now has 65 tokenA and 186.239802986 tokenB
        expect(await token0.balanceOf(pair.address)).to.eq(expandTo18Decimals(65)) // = 5 (lisa) + 50 (lily) + 10 (tim)
        expect(await token1.balanceOf(pair.address)).to.eq(bigNumberify('186239802985993535478')) // = 20 (lisa) + 200 (lily) - 33.760197014006464522(tim)

        // after the swap, both lisa and lily has earned some fee paid by tim.
        // now lisa decides to withdraw her tokens.
        // lisa will call removeLiquidity with all her liquidity tokens.
        // but before removeLiquidity, lisa needs to approve uniswap to transfer her
        // liquidity on her behalf, other removeLiquidity will fail
        await pair.connect(lisa).approve(router.address, MaxUint256)

        // lisa remove liquidity with all her liquidity tokens
        await router.connect(lisa).removeLiquidity(
          token0.address,
          token1.address,
          expandTo18Decimals(10).sub(MINIMUM_LIQUIDITY),
          0,
          0,
          lisa.address,
          MaxUint256,
          overrides
        )

        // before lisa removing liquidity, the pool had 65 tokenA and 186.239802986 tokenB,
        // since lisa owns 9.0909% liquidity, after lisa removing liquidity, lisa received
        // 5.9090909 tokenA (65 * 9.090909%) and 16.9308911 tokenB (186.239802986 * 9.090909%)
        expect(await token0.balanceOf(lisa.address)).to.eq(bigNumberify('5909090909090908500')) // 65 * 9.090909%
        expect(await token1.balanceOf(lisa.address)).to.eq(bigNumberify('16930891180544865168')) // 186.239802986 * 9.090909%

        // after lisa removed liquidity, the pool now has 59.090909 tokenA and 169.30891 tokenB
        expect(await token0.balanceOf(pair.address)).to.eq(bigNumberify('59090909090909091500')) // = 65 - 5.9090909
        expect(await token1.balanceOf(pair.address)).to.eq(bigNumberify('169308911805448670310')) // = 186.239802986 - 16.9308911

        // now lily also decides to removeLiquidity, she had the remaining 100 liquidity tokens
        expect(await pair.balanceOf(lily.address)).to.eq(expandTo18Decimals(100))

        // lily also needs to approve uniswap to transfer her liquidity token on her behalf
        await pair.connect(lily).approve(router.address, MaxUint256)

        // lily remove liquidity with all her liquidity tokens
        await router.connect(lily).removeLiquidity(
          token0.address,
          token1.address,
          expandTo18Decimals(100),
          0,
          0,
          lily.address,
          MaxUint256,
          overrides
        )

        // confirm lily received 59.090909 tokenA (65 * 90.909090%) and 169.3089118 tokenB (186.239802986 * 90.909090%)
        expect(await token0.balanceOf(lily.address)).to.eq(bigNumberify('59090909090909090909')) // 65 * 90.909090%
        expect(await token1.balanceOf(lily.address)).to.eq(bigNumberify('169308911805448668616')) // 186.239802986 * 90.909090%


        // after all liquidity removed their liquidity, let's give a look at the contract's state
        expect(await pair.totalSupply()).to.eq(MINIMUM_LIQUIDITY) // a tiny amount of liquidity token
        expect(await token0.balanceOf(pair.address)).to.eq(591) // a tiny amount of tokenA
        expect(await token1.balanceOf(pair.address)).to.eq(1691) // a tiny amount of tokenB
      })
    })
  }
})
