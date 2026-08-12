import { Controller, Get, HttpCode, HttpStatus, Param, Post, Query } from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import { Endpoint, HistoryBuilder } from 'src/decorators';
import { AuthDto } from 'src/dtos/auth.dto';
import { BurstGroupResponseDto, BurstGroupSearchDto } from 'src/dtos/burst.dto';
import { ApiTag, Permission } from 'src/enum';
import { Auth, Authenticated } from 'src/middleware/auth.guard';
import { BurstService } from 'src/services/burst.service';
import { UUIDv7ParamDto } from 'src/validation';

@ApiTags(ApiTag.Bursts)
@Controller('burst-groups')
export class BurstController {
  constructor(private service: BurstService) {}

  @Get()
  @Authenticated({ permission: Permission.BurstGroupRead })
  @Endpoint({
    summary: 'Retrieve burst groups',
    description: 'Retrieve detected multi-shot burst groups, optionally filtered by status.',
    history: new HistoryBuilder().added('v3'),
  })
  searchBurstGroups(@Auth() auth: AuthDto, @Query() query: BurstGroupSearchDto): Promise<BurstGroupResponseDto[]> {
    return this.service.getAll(auth, query);
  }

  @Get(':id')
  @Authenticated({ permission: Permission.BurstGroupRead })
  @Endpoint({
    summary: 'Retrieve a burst group',
    description: 'Retrieve a single burst group by its ID.',
    history: new HistoryBuilder().added('v3'),
  })
  getBurstGroup(@Auth() auth: AuthDto, @Param() { id }: UUIDv7ParamDto): Promise<BurstGroupResponseDto> {
    return this.service.get(auth, id);
  }

  @Post(':id/accept')
  @Authenticated({ permission: Permission.BurstGroupUpdate })
  @Endpoint({
    summary: 'Accept a burst group',
    description: 'Turn the frames of a candidate burst group into a stack.',
    history: new HistoryBuilder().added('v3'),
  })
  acceptBurstGroup(@Auth() auth: AuthDto, @Param() { id }: UUIDv7ParamDto): Promise<BurstGroupResponseDto> {
    return this.service.accept(auth, id);
  }

  @Post(':id/dismiss')
  @HttpCode(HttpStatus.OK)
  @Authenticated({ permission: Permission.BurstGroupUpdate })
  @Endpoint({
    summary: 'Dismiss a burst group',
    description: 'Reject a candidate burst group so it is not offered again.',
    history: new HistoryBuilder().added('v3'),
  })
  dismissBurstGroup(@Auth() auth: AuthDto, @Param() { id }: UUIDv7ParamDto): Promise<BurstGroupResponseDto> {
    return this.service.dismiss(auth, id);
  }
}
